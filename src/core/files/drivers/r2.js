import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import env from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';

/**
 * Cloudflare R2 storage.
 *
 * R2 speaks the S3 API, so this is the AWS SDK pointed at Cloudflare's
 * endpoint. Two differences from S3 that matter here: the region is always
 * "auto", and there are no egress charges — which is the reason event banners
 * can be served straight out of it without watching a bandwidth bill.
 *
 * Unlike Drive, the storage key we generate is the object key. Nothing has to
 * be flattened, renamed or translated, and a human cannot wander into a bucket
 * and delete a banner.
 */

/** A key the bucket does not have. Marked so the service can return a 404. */
export class ObjectMissingError extends Error {
  constructor(key, cause = null) {
    super(`Object ${key} is not in the bucket`);
    this.name = 'ObjectMissingError';
    this.notFound = true;
    if (cause) this.cause = cause;
  }
}

const isMissing = (err) => err?.name === 'NoSuchKey'
  || err?.name === 'NotFound'
  || err?.$metadata?.httpStatusCode === 404;

/**
 * Built on first use. The API and the worker both import this module, and a
 * process that never touches a file should not open a connection pool.
 */
export function createR2Driver() {
  let client = null;

  function s3() {
    if (client) return client;

    client = new S3Client({
      // R2 has no regions; the SDK insists on one, and "auto" is what
      // Cloudflare documents.
      region: 'auto',
      endpoint: env.R2_ENDPOINT
        || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      // R2 serves buckets as a subdomain of the account endpoint, which is the
      // SDK's default. Only an S3-compatible stand-in needs path style.
      forcePathStyle: env.R2_FORCE_PATH_STYLE,

      /**
       * From v3.729 the SDK adds CRC32 integrity headers to every request by
       * default. Cloudflare recommends WHEN_REQUIRED for R2, which does not
       * implement that flavour of checksum on all operations.
       *
       * Kept as a precaution rather than a fix for anything observed here: an
       * S3-compatible server accepts uploads either way, and this has not been
       * exercised against live R2.
       */
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    logger.info({ bucket: env.R2_BUCKET, account: env.R2_ACCOUNT_ID }, 'r2 storage initialised');
    return client;
  }

  const Bucket = () => env.R2_BUCKET;

  return {
    name: 'r2',

    async put(key, buffer, { mimeType = 'application/octet-stream' } = {}) {
      await s3().send(new PutObjectCommand({
        Bucket: Bucket(),
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        /**
         * Recorded on the object so the bucket is still intelligible without
         * the database — useful when working out what a stray object is.
         */
        Metadata: { purpose: String(key).split('/')[0] },
      }));

      // The key we were given is the key it is stored under.
      return { key };
    },

    async stream(key) {
      try {
        const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
        return res.Body;
      } catch (err) {
        if (isMissing(err)) throw new ObjectMissingError(key, err);
        throw err;
      }
    },

    async buffer(key) {
      try {
        const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
        // transformToByteArray is provided by the SDK's stream mixin.
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (isMissing(err)) throw new ObjectMissingError(key, err);
        throw err;
      }
    },

    async remove(key) {
      // S3 delete is idempotent: removing a key that is already gone succeeds,
      // which is the end state we want anyway.
      await s3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: key }));
    },

    /**
     * A time-limited URL for one object. Unused by the current file routes,
     * which stream everything through the API so access control runs on every
     * read — but real, so serving large private files by redirect later is a
     * routing change rather than a storage one.
     */
    async signedUrl(key, { expiresInSeconds = 300 } = {}) {
      return getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: Bucket(), Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },

    /** Proves the credentials and that the bucket exists and is reachable. */
    async verify() {
      try {
        await s3().send(new HeadBucketCommand({ Bucket: Bucket() }));
        return { bucket: Bucket(), account: env.R2_ACCOUNT_ID };
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404) {
          throw new Error(`Bucket "${Bucket()}" does not exist in this R2 account`);
        }
        if (err?.$metadata?.httpStatusCode === 403) {
          throw new Error(
            `Access denied to bucket "${Bucket()}". Check the API token has R2 read and write, `
            + 'and that the access key belongs to this account.',
          );
        }
        throw err;
      }
    },

    async close() {
      if (client) {
        client.destroy();
        client = null;
      }
    },
  };
}

export const r2Driver = createR2Driver();

export default r2Driver;
