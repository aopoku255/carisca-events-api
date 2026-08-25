import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Every environment variable the application reads is declared here and nowhere
 * else. Boot fails loudly on a missing or malformed value rather than surfacing
 * as an undefined halfway through a payment.
 */

/**
 * `z.coerce.boolean()` is `Boolean(string)`, so the literal "false" parses as
 * true — which for a flag like SMTP_SECURE would silently open the wrong kind
 * of connection. This reads the word, not the truthiness.
 */
const bool = (fallback) => z
  .preprocess(
    // A key present but blank — `R2_FORCE_PATH_STYLE=` — means "not set", the
    // same as omitting the line. Treating it as an invalid value instead would
    // refuse to boot over an empty field in a .env file.
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['true', 'false', '1', '0', 'yes', 'no']).default(fallback ? 'true' : 'false'),
  )
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  // Only used to link a new staff account to the right place to sign in —
  // the public site and the console are different apps at different origins.
  ADMIN_URL: z.string().url().default('http://localhost:3001'),

  // --- database -----------------------------------------------------------
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: z.string().default('carisca_dev'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  // Not z.coerce.boolean(), which is Boolean(string) and so reads the literal
  // "false" as true — quietly logging every query in production.
  DB_LOGGING: bool(false),

  // --- redis --------------------------------------------------------------
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // --- auth ---------------------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(48),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  // --- platform behaviour -------------------------------------------------
  REGISTRATION_HOLD_MINUTES: z.coerce.number().int().positive().default(30),
  PERMISSION_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // --- providers (optional until the module that needs them is switched on) -
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('CARISCA <no-reply@carisca.knust.edu.gh>'),
  MAIL_REPLY_TO: z.string().optional(),

  // --- smtp (required only when MAIL_DRIVER=smtp; see the refinement below) --
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // Implicit TLS on connect (port 465). Port 587 upgrades via STARTTLS instead,
  // which nodemailer does automatically, so this stays false there.
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // Escape hatch for a relay with a self-signed certificate. Never in production.
  SMTP_ALLOW_SELF_SIGNED: bool(false),
  SMTP_POOL_MAX_CONNECTIONS: z.coerce.number().int().positive().default(3),

  STORAGE_DRIVER: z.enum(['local', 's3', 'gcs', 'gdrive', 'r2']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),

  // --- cloudflare r2 (required only when STORAGE_DRIVER=r2) -----------------
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  // Overrides the derived account endpoint. Only needed for a custom or
  // jurisdiction-specific endpoint (eu, fedramp).
  R2_ENDPOINT: z.string().url().optional().or(z.literal('')),
  // R2 addresses buckets as a subdomain, which is the SDK default. Path style
  // is what S3-compatible servers used for local testing (MinIO) expect.
  R2_FORCE_PATH_STYLE: bool(false),

  // --- google drive (required only when STORAGE_DRIVER=gdrive) --------------
  // The destination folder, which must live inside a Shared Drive.
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  // Supply the service account key either as a file path or inline; inline
  // accepts raw JSON or base64, for hosts whose config UI mangles newlines.
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().default('./service-account.json'),
  GOOGLE_SERVICE_ACCOUNT_KEY_JSON: z.string().optional(),
  /**
   * Act as this Workspace user instead of as the service account itself, so
   * uploaded files are owned by them and draw on their quota. Needed only when
   * the destination is a My Drive folder; requires domain-wide delegation.
   */
  GOOGLE_DRIVE_IMPERSONATE_USER: z.string().email().optional().or(z.literal('')),

  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})
  /**
   * Mail is the one subsystem whose failure is invisible: a missing SMTP host
   * does not break a request, it silently leaves every verification email
   * stuck in the outbox until someone notices nobody can sign in. So the
   * settings are checked at boot, where the error is unmissable.
   */
  .superRefine((data, ctx) => {
    if (data.MAIL_DRIVER === 'smtp') {
      if (!data.SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_HOST'],
          message: 'is required when MAIL_DRIVER=smtp',
        });
      }
      // Some internal relays authenticate by IP, so credentials are optional —
      // but half a credential pair is always a mistake.
      if (Boolean(data.SMTP_USER) !== Boolean(data.SMTP_PASSWORD)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_USER'],
          message: 'SMTP_USER and SMTP_PASSWORD must be set together, or both left empty',
        });
      }
    }

    if (data.STORAGE_DRIVER === 'r2') {
      // Named individually rather than as one "R2 is misconfigured": the whole
      // point of validating at boot is to say which value is missing.
      for (const key of ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
        if (!data[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when STORAGE_DRIVER=r2',
          });
        }
      }
      // The endpoint is derived from the account id unless one is given
      // outright, so exactly one of the two must be present.
      if (!data.R2_ACCOUNT_ID && !data.R2_ENDPOINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['R2_ACCOUNT_ID'],
          message: 'is required when STORAGE_DRIVER=r2 (or set R2_ENDPOINT directly)',
        });
      }
    }

    if (data.STORAGE_DRIVER === 'gdrive' && !data.GOOGLE_DRIVE_FOLDER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_DRIVE_FOLDER_ID'],
        message: 'is required when STORAGE_DRIVER=gdrive',
      });
    }

    if (data.NODE_ENV === 'production') {
      if (data.MAIL_DRIVER === 'log') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_DRIVER'],
          message: 'cannot be "log" in production — no email would ever be delivered',
        });
      }
      if (data.SMTP_ALLOW_SELF_SIGNED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_ALLOW_SELF_SIGNED'],
          message: 'must not be enabled in production',
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
});

export default env;
