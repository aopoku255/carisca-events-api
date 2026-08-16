/**
 * Proves the storage configuration end to end: authenticates, checks the
 * destination really is a writable folder in a Shared Drive, then uploads a
 * real file, reads it back, compares the bytes and deletes it.
 *
 *   node scripts/test-storage.js
 *
 * Touches no database rows — it drives the driver directly, so it is safe to
 * run against any environment.
 */
import crypto from 'node:crypto';
import env from '../src/config/env.js';
import { localDriver } from '../src/core/files/drivers/local.js';
import { driveDriver } from '../src/core/files/drivers/gdrive.js';
import { r2Driver } from '../src/core/files/drivers/r2.js';

const out = (s) => process.stdout.write(`${s}\n`);

// A 1x1 PNG: small, and a real image rather than something the upload path
// would be right to reject.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DRIVERS = { local: localDriver, gdrive: driveDriver, r2: r2Driver };

async function main() {
  const driver = DRIVERS[env.STORAGE_DRIVER];

  if (!driver) {
    out(`STORAGE_DRIVER is "${env.STORAGE_DRIVER}", which has no driver yet.`);
    out(`Available: ${Object.keys(DRIVERS).join(', ')}`);
    process.exit(1);
  }

  out(`driver:  ${env.STORAGE_DRIVER}`);
  if (env.STORAGE_DRIVER === 'gdrive') {
    out(`folder:  ${env.GOOGLE_DRIVE_FOLDER_ID}`);
    out(`key:     ${env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON ? '(inline from env)' : env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE}`);
  } else if (env.STORAGE_DRIVER === 'r2') {
    out(`bucket:  ${env.R2_BUCKET}`);
    out(`account: ${env.R2_ACCOUNT_ID || '(using R2_ENDPOINT)'}`);
    out(`key id:  ${env.R2_ACCESS_KEY_ID?.slice(0, 6)}… (${env.R2_ACCESS_KEY_ID?.length ?? 0} chars)`);
  } else {
    out(`path:    ${env.STORAGE_LOCAL_PATH}`);
  }
  out('');

  if (driver.verify) {
    out('Checking the destination…');
    const info = await driver.verify();

    if (info.bucket) {
      out(`  ok — bucket "${info.bucket}" is reachable and writable`);
    } else {
      out(`  ok — folder "${info.folder}"${info.driveId
        ? ` in shared drive ${info.driveId}`
        : ` in ${info.actingAs}'s My Drive`}`);
      if (info.actingAs) out(`  acting as ${info.actingAs}`);
    }
    out('');
  }

  const key = `storage-check/${crypto.randomBytes(8).toString('hex')}.png`;

  out('Uploading…');
  const { key: storedKey } = await driver.put(key, PNG, { mimeType: 'image/png' });
  out(`  stored as ${storedKey}\n`);

  let uploaded = true;

  try {
    out('Reading it back…');
    const roundTripped = await driver.buffer(storedKey);

    if (!roundTripped.equals(PNG)) {
      throw new Error(`Bytes differ: sent ${PNG.length}, got back ${roundTripped.length}`);
    }
    out(`  ok — ${roundTripped.length} bytes, identical\n`);

    out('Streaming it…');
    const stream = await driver.stream(storedKey);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    if (!Buffer.concat(chunks).equals(PNG)) throw new Error('Streamed bytes differ');
    out('  ok\n');

    const signed = await driver.signedUrl?.(storedKey, { expiresInSeconds: 60 });
    if (signed) {
      out('Signing a temporary URL…');
      out(`  ok — ${signed.split('?')[0]}?…\n`);
    }
  } finally {
    if (uploaded) {
      out('Cleaning up…');
      await driver.remove(storedKey).catch((err) => {
        uploaded = false;
        out(`  could not delete ${storedKey}: ${err.message}`);
        out('  remove it by hand.');
      });
      if (uploaded) out('  deleted\n');
    }
  }

  out('Storage is configured correctly.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    out(`\nFAILED: ${err.message}`);

    // The three ways this goes wrong that are not obvious from the error text.
    if (/quota|storageQuotaExceeded/i.test(err.message)) {
      out('\nA service account has no storage of its own, so it cannot own files.');
      out('Either put the folder in a Shared Drive, or set');
      out('GOOGLE_DRIVE_IMPERSONATE_USER to the folder owner so files are owned');
      out('by them (needs domain-wide delegation in the Workspace admin console).');
    }
    if (/unauthorized_client/i.test(err.message)) {
      out('\nDomain-wide delegation is not authorised. In the Workspace admin');
      out('console, add the service account\'s numeric client id under');
      out('Security > API controls > Domain-wide delegation, with the scope');
      out('https://www.googleapis.com/auth/drive');
    }
    if (/404|not found|notFound/i.test(err.message)) {
      out('\nA 404 here usually means the service account was never added to the');
      out('Shared Drive — to it, the folder genuinely does not exist. Share the');
      out('drive with the client_email from the service account key.');
    }
    if (/invalid_grant|invalid_client|unauthorized/i.test(err.message)) {
      out('\nCheck the key file is the JSON one for this project, and that the');
      out('Drive API is enabled for it in the Google Cloud console.');
    }

    process.exit(1);
  });
