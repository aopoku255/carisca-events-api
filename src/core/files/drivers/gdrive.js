import { Readable } from 'node:stream';
import fs from 'node:fs';
import { drive as driveApi, auth as driveAuth } from '@googleapis/drive';
import env from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';

/**
 * Google Drive storage, backed by a Shared Drive.
 *
 * It must be a *Shared* Drive, not a folder in someone's My Drive. A service
 * account has no storage quota of its own, so an upload into My Drive fails
 * outright; files in a Shared Drive are owned by the drive itself, which is
 * also what stops them disappearing when a staff account is deprovisioned.
 *
 * Every Drive call passes `supportsAllDrives`. Without it the API pretends
 * Shared Drives do not exist and returns a bare 404 for a file that is plainly
 * there — the single most common way this integration is misconfigured.
 */

const SCOPES = [
  /**
   * Full drive rather than drive.file, because drive.file only grants access to
   * files the app itself created — which breaks the moment anyone moves a file
   * in the Drive UI, and gives no way to recover it. The blast radius is still
   * only what the service account can see, and it is a member of exactly one
   * Shared Drive.
   */
  'https://www.googleapis.com/auth/drive',
];

/** Drive has no directories in a storage key, so the path becomes the name. */
function fileNameFor(key) {
  return String(key).replace(/\//g, '_');
}

function credentials() {
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON.trim();
    // Accept base64 as well: a PEM private key carries newlines, which most
    // hosting panels mangle when pasted into an environment variable.
    const json = raw.startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    try {
      return JSON.parse(json);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not valid JSON or base64-encoded JSON');
    }
  }

  const path = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!fs.existsSync(path)) {
    throw new Error(`Service account key file not found at ${path}`);
  }
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

/**
 * Not a 404 from us — a 404 from Drive means the file is gone (or the service
 * account lost sight of it). Marked so the storage service can turn it into a
 * clean NotFound rather than a 500.
 */
export class DriveFileMissingError extends Error {
  constructor(fileId, cause = null) {
    super(`Drive file ${fileId} is not accessible`);
    this.name = 'DriveFileMissingError';
    this.notFound = true;
    if (cause) this.cause = cause;
  }
}

const isMissing = (err) => err?.code === 404 || err?.response?.status === 404;

/**
 * Built on first use. The API process and the worker both import this module
 * but a process that never touches a file should not be minting OAuth tokens
 * at boot.
 */
export function createDriveDriver() {
  let client = null;

  function drive() {
    if (client) return client;

    const key = credentials();
    const impersonate = env.GOOGLE_DRIVE_IMPERSONATE_USER || null;

    client = driveApi({
      version: 'v3',
      auth: new driveAuth.GoogleAuth({
        credentials: key,
        scopes: SCOPES,
        // Domain-wide delegation: every call is made as this user, so files are
        // owned by them and count against their Workspace quota rather than
        // the service account's — which is zero.
        clientOptions: impersonate ? { subject: impersonate } : undefined,
      }),
    });

    logger.info({
      serviceAccount: key.client_email,
      actingAs: impersonate,
      folder: env.GOOGLE_DRIVE_FOLDER_ID,
    }, 'google drive storage initialised');

    return client;
  }

  return {
    name: 'gdrive',

    async put(key, buffer, { mimeType = 'application/octet-stream' } = {}) {
      const { data } = await drive().files.create({
        requestBody: {
          name: fileNameFor(key),
          parents: [env.GOOGLE_DRIVE_FOLDER_ID],
          /**
           * The generated storage key is kept as file metadata so a file can
           * still be traced back to its row after someone renames it in the
           * Drive UI.
           */
          appProperties: { cariscaKey: String(key) },
        },
        media: { mimeType, body: Readable.from(buffer) },
        fields: 'id',
        supportsAllDrives: true,
      });

      if (!data?.id) throw new Error('Drive accepted the upload but returned no file id');

      // The Drive file id becomes the storage key: it is what every later read
      // is addressed by, and it survives a rename.
      return { key: data.id };
    },

    async stream(fileId) {
      try {
        const res = await drive().files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' },
        );
        return res.data;
      } catch (err) {
        if (isMissing(err)) throw new DriveFileMissingError(fileId, err);
        throw err;
      }
    },

    async buffer(fileId) {
      try {
        const res = await drive().files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer' },
        );
        return Buffer.from(res.data);
      } catch (err) {
        if (isMissing(err)) throw new DriveFileMissingError(fileId, err);
        throw err;
      }
    },

    async remove(fileId) {
      try {
        await drive().files.delete({ fileId, supportsAllDrives: true });
      } catch (err) {
        // Already gone is the desired end state.
        if (!isMissing(err)) throw err;
      }
    },

    /**
     * Drive's sharing links are permanent and all-or-nothing — there is no
     * expiring URL to hand out — so files are always streamed through the API,
     * where the per-request access checks in file.routes.js still apply.
     */
    async signedUrl() {
      return null;
    },

    /** Proves the credentials, the folder id and the Shared Drive membership. */
    async verify() {
      const { data } = await drive().files.get({
        fileId: env.GOOGLE_DRIVE_FOLDER_ID,
        fields: 'id,name,mimeType,driveId,capabilities/canAddChildren',
        supportsAllDrives: true,
      });

      if (data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error(`GOOGLE_DRIVE_FOLDER_ID is a ${data.mimeType}, not a folder`);
      }

      /**
       * A My Drive folder is only workable while impersonating a real user:
       * files are then owned by them and draw on their quota. Without that the
       * owner would be the service account, whose quota is zero, and every
       * upload fails on storageQuotaExceeded.
       */
      if (!data.driveId && !env.GOOGLE_DRIVE_IMPERSONATE_USER) {
        throw new Error(
          'That folder is in a personal My Drive, not a Shared Drive. '
          + 'A service account has no storage quota there and uploads will fail. '
          + 'Either move it to a Shared Drive, or set GOOGLE_DRIVE_IMPERSONATE_USER '
          + 'to the folder owner and enable domain-wide delegation.',
        );
      }

      if (!data.capabilities?.canAddChildren) {
        throw new Error(
          'The service account can see the folder but cannot write to it. '
          + 'Add it to the Shared Drive as Content Manager.',
        );
      }

      return {
        folder: data.name,
        driveId: data.driveId ?? null,
        actingAs: env.GOOGLE_DRIVE_IMPERSONATE_USER || null,
      };
    },
  };
}

export const driveDriver = createDriveDriver();

export default driveDriver;
