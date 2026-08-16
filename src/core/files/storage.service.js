import crypto from 'node:crypto';
import { models } from '../../database/models/index.js';
import env from '../../config/env.js';
import { localDriver } from './drivers/local.js';
import { driveDriver } from './drivers/gdrive.js';
import { r2Driver } from './drivers/r2.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const { File } = models;

/**
 * Central file storage.
 *
 * Callers hand over a buffer and a purpose; they never learn where it went.
 * Swapping local disk for S3 or GCS is registering another driver here — no
 * controller changes.
 *
 * The provider is recorded per file, not read from configuration at read time,
 * so switching STORAGE_DRIVER only affects new uploads. Everything already on
 * disk keeps being served from disk.
 */

const drivers = { local: localDriver, gdrive: driveDriver, r2: r2Driver };

function driverFor(provider = env.STORAGE_DRIVER) {
  const driver = drivers[provider];
  if (!driver) {
    throw new AppError(`Storage driver "${provider}" is not configured.`, {
      status: 500, code: 'STORAGE_UNAVAILABLE',
    });
  }
  return driver;
}

/**
 * What each purpose accepts. Declared per purpose rather than globally,
 * because an event banner and a scanned student ID have different risk.
 */
export const PURPOSES = {
  event_banner: {
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
    visibility: 'PUBLIC',
  },
  speaker_photo: {
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 3 * 1024 * 1024,
    visibility: 'PUBLIC',
  },
  organization_logo: {
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'],
    maxBytes: 2 * 1024 * 1024,
    visibility: 'PUBLIC',
  },
  certificate_template: {
    mimes: ['image/jpeg', 'image/png', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    visibility: 'PRIVATE',
  },
  registration_evidence: {
    mimes: ['image/jpeg', 'image/png', 'application/pdf'],
    maxBytes: 8 * 1024 * 1024,
    visibility: 'PRIVATE',
  },
  certificate: {
    mimes: ['application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    visibility: 'PRIVATE',
  },
};

/**
 * Identifies a file from its leading bytes.
 *
 * The declared Content-Type is supplied by the uploader and is therefore not
 * evidence of anything: a script renamed to .png arrives claiming image/png.
 * Only the magic bytes decide what we accept and what we later serve it as.
 */
export function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (b.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';

  // SVG is text, and is deliberately not sniffed here — it can carry script,
  // so it is only accepted where a purpose explicitly allows it and is always
  // served as a download rather than inline.
  const head = b.subarray(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';

  return null;
}

export async function store({
  buffer, originalName, declaredMime, purpose, uploadedBy = null,
}) {
  const rules = PURPOSES[purpose];
  if (!rules) {
    throw new ValidationError([{ field: 'purpose', message: 'Unknown upload purpose.' }]);
  }

  if (!buffer?.length) {
    throw new ValidationError([{ field: 'file', message: 'The file is empty.' }]);
  }

  if (buffer.length > rules.maxBytes) {
    throw new ValidationError([{
      field: 'file',
      message: `That file is too large. The limit is ${Math.round(rules.maxBytes / 1024 / 1024)}MB.`,
    }]);
  }

  const actualMime = sniffMime(buffer);

  if (!actualMime) {
    throw new ValidationError([{ field: 'file', message: 'That file type is not recognised.' }]);
  }

  if (!rules.mimes.includes(actualMime)) {
    // Reported against what the file actually is, not what it claimed, so the
    // message is true even when the two disagree.
    throw new ValidationError([{
      field: 'file',
      message: `${actualMime} files are not accepted here. Allowed: ${rules.mimes.join(', ')}.`,
    }]);
  }

  if (declaredMime && declaredMime !== actualMime) {
    logger.warn({ declaredMime, actualMime, purpose, uploadedBy },
      'upload content-type did not match its contents');
  }

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const extension = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
  }[actualMime] ?? 'bin';

  // Random, never derived from the filename: unguessable and traversal-proof.
  const key = `${purpose}/${new Date().getFullYear()}/${crypto.randomBytes(16).toString('hex')}.${extension}`;

  const driver = driverFor();
  /**
   * The driver may address the object by something other than the key it was
   * offered — Drive assigns its own file id — so what it hands back is what
   * gets stored and used for every later read.
   */
  const stored = await driver.put(key, buffer, { mimeType: actualMime });

  const file = await File.create({
    storage_provider: driver.name,
    storage_key: stored?.key ?? key,
    // Kept for display only; never used to build a path.
    original_name: String(originalName ?? 'upload').slice(0, 255),
    mime_type: actualMime,
    size_bytes: buffer.length,
    checksum,
    visibility: rules.visibility,
    purpose,
    uploaded_by: uploadedBy,
  });

  logger.info({ fileId: file.id, purpose, mime: actualMime, bytes: buffer.length }, 'file stored');
  return file;
}

export async function find(id) {
  const file = await File.findByPk(id);
  if (!file) throw new NotFoundError('File');
  return file;
}

/**
 * A file the provider no longer has is a 404, not a 500. This is not
 * hypothetical with Drive: the Shared Drive is browsable, so someone tidying it
 * up can delete an object the database still points at. The row is left alone —
 * it is the audit record of what was uploaded, and guessing that a read failure
 * means "delete the metadata" would turn a transient outage into data loss.
 */
function rethrowMissing(err) {
  if (err?.notFound) throw new NotFoundError('File');
  throw err;
}

export async function streamFor(file) {
  return driverFor(file.storage_provider)
    .stream(file.storage_key)
    .catch(rethrowMissing);
}

export async function bufferFor(file) {
  return driverFor(file.storage_provider)
    .buffer(file.storage_key)
    .catch(rethrowMissing);
}

export async function remove(file) {
  await driverFor(file.storage_provider).remove(file.storage_key);
  await file.destroy();
}

/** The URL a client should use. Public files are cacheable; private are not. */
export function urlFor(file) {
  if (!file) return null;
  return `/files/${file.id}`;
}

export function serialiseFile(file) {
  if (!file) return null;
  return {
    id: String(file.id),
    url: urlFor(file),
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes),
    originalName: file.original_name,
    visibility: file.visibility,
  };
}

export default { store, find, streamFor, bufferFor, remove, urlFor, serialiseFile, sniffMime, PURPOSES };
