# CARISCA API

Backend for the CARISCA Integrated Events & Programs Platform — a modular
monolith serving CPD, and designed so Summit and Business Forum plug into the
same core without duplication.

Node · Express · Sequelize · MySQL · Redis. JavaScript (ESM).

---

## Status

**Phase 1 — foundation. Complete and tested.**

| Area | State |
|---|---|
| Database schema (all 34 tables) | ✅ migrated, rollback verified |
| Seeders — permissions, roles, countries, currencies, routing | ✅ |
| Authentication — register, verify, login, refresh rotation, reset | ✅ |
| RBAC — 46 permissions, 8 roles, per-request resolution | ✅ |
| Audit log with database-enforced immutability | ✅ |
| Notification outbox | ✅ (dispatcher worker is Week 1) |
| Money as integer minor units | ✅ |
| Participant demographics + M&E vocabularies | ✅ |
| Conditional price resolution | ✅ |
| Test suite | ✅ 103 tests |
| CPD module | ⬜ Week 1 |
| Payments — Paystack / Stripe | ⬜ Week 2 |
| Attendance, certificates | ⬜ Week 3 |

---

## Getting started

Requires Node 20.11+, MySQL 8+, Redis 6+.

```bash
# macOS
brew install node mysql redis
brew services start mysql
brew services start redis

npm install
cp .env.example .env

# Generate two distinct secrets and paste them into .env
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET

npm run db:create
npm run db:migrate
npm run db:seed        # prints the generated admin password once
npm run dev
```

`GET http://localhost:4000/health` should return `"database": "ok"`.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with watch |
| `npm start` | Production server |
| `npm run worker` | Background job worker (Week 1) |
| `npm test` | Full suite against `carisca_dev_test` |
| `npm run mail:test you@example.com` | Verify the SMTP settings by sending a real templated email |
| `npm run storage:test` | Verify the storage settings with an upload / read-back / delete round trip |
| `npm run db:migrate` / `db:migrate:undo` | Apply / roll back one migration |
| `npm run db:seed` | Run all seeders |
| `npm run db:reset` | Drop, create, migrate, seed |

### A note on Redis 8 via Homebrew

The bundled `redis.conf` references modules the formula does not ship
(`redisbloom`, `redisearch`, `redisjson`, `redistimeseries`), and Redis aborts
on startup. Comment out those four `loadmodule` lines in
`/usr/local/etc/redis.conf`. None of them are needed here.

---

## How this is put together

### Modular monolith

```
src/
├── config/      env schema (validated at boot), database, redis
├── lib/         errors, response envelope, money, ids, pagination, logger
├── core/        platform services shared by every module
│   ├── auth/ users/ rbac/ audit/ notifications/ admin/
│   └── events/ registrations/ payments/ certificates/ …   (built per phase)
├── modules/     business rules only — thin over core
│   ├── cpd/           ← the first real module
│   ├── summit/        ← scaffold
│   └── business-forum/← scaffold
├── database/    migrations, seeders, models
├── routes.js    the single place modules are mounted
└── app.js
```

A module owns routes, controllers, services, validation and its own permission
definitions. It does **not** own a database connection, a payment client or a
mailer. When CPD needs money taken it calls `paymentService.createIntent(…)`
and never learns whether Paystack or Stripe handled it.

### The rule that makes a second module cheap

`registrations`, `payments`, `attendance_records` and `certificates` all
foreign-key to `events.id` — never to a module's own table. Adding Summit is a
row in `event_types`, an optional `summit_event_details` extension table, its
permissions in `permissions.json`, and one line in `routes.js`.

### Authorization

Permissions are **never** carried in the JWT. The access token holds only a
user id and a token version, and lives 15 minutes. Effective permissions are
resolved per request from Redis (60s TTL) and invalidated on any role change.

`users.token_version` is the kill switch: bumping it invalidates every
outstanding token for that user immediately. It is bumped on deactivation,
password reset and password change.

This is what makes *"admin permissions changed"* and *"admin account disabled"*
take effect in seconds rather than whenever a token happens to expire — both
are covered by tests.

Chain: `authenticate → requireStaff → loadPermissions → requirePermission('…')`.
Permission strings are validated against `src/core/rbac/permissions.json` at
route-definition time, so a typo throws at boot rather than silently denying
everyone.

### Money

`BIGINT amount_minor` + `CHAR(3) currency`, always. The decimal exponent comes
from the `currencies` table — nothing assumes two places, so JPY (0) and KWD
(3) work. `src/lib/money.js` parses via string and `BigInt`; no float ever
touches an amount.

### What we collect, and where it lives

Modelled from the live form at `cpd.carisca.org`.

**On the user** — collected once, prefilled on every later programme: prefix,
first/middle/last name, suffix, gender, phone, organization, position, sector,
city, state/province, country, mailing-list preference.

**On the registration** — specific to attending this event: attendance mode
(in-person / virtual), whether a certificate is wanted, previous CARISCA
attendance, comments, media-consent timestamp and IP, and any supporting
evidence file such as a student ID.

**Position** (16 values) and **Sector** (6) are reference tables copied
verbatim from the live form so M&E can compare cohorts across years. Adding a
category is a row, not a migration. `positions.requires_student_id` drives the
conditional ID upload, so that rule is data rather than a hard-coded check for
the word "student".

**Continent is derived from the country**, not asked separately. The live form
asks for both, which permits "Ghana, Europe".

### Pricing

One event can be priced several ways at once. CARISCA's current CPD is the
worked example:

| | Virtual | In-Person |
|---|---|---|
| Africa | $25 | $50 |
| Outside Africa | $25 | $150 |
| Ghana (GHS) | 1000 | 1500 |

Each `event_prices` row carries the conditions under which it applies —
`attendance_mode`, `audience` (`HOST_COUNTRY` / `AFRICA` / `INTERNATIONAL` /
`ANY`), currency and an availability window. `resolvePrice()` picks the most
specific match; ties break on `priority`, then on the **lower** amount, so an
ambiguous configuration never overcharges a participant. Nothing matching is
an error rather than a free ticket.

Adding a student or early-bird rate is a row. See
`tests/integration/pricing.test.js`, which uses the real published fees.

### Audit log

Append-only, enforced by MySQL triggers that raise `SQLSTATE 45000` on UPDATE
or DELETE — not by convention. Secrets are scrubbed from `before`/`after`
before they are written. Deleting a user nulls `actor_user_id` but keeps the
denormalised `actor_email`, so the trail survives.

### File storage

Callers hand `storage.store()` a buffer and a purpose and never learn where it
went. The type is decided by sniffing the leading bytes, not by the uploader's
Content-Type, and each purpose declares its own limits — an event banner and a
scanned student ID carry different risk.

The provider is recorded per file rather than read from configuration at read
time, so changing `STORAGE_DRIVER` only affects new uploads; everything already
on disk keeps being served from disk. Files are always streamed through
`GET /files/:id`, which applies access control on every read — nothing is
reachable by URL guessing, and private files never get a public link.

**Cloudflare R2** (`STORAGE_DRIVER=r2`) is the production choice. It speaks the
S3 API, charges nothing for egress — which matters when every event banner is
served from it — and unlike a Drive folder, nobody can wander in and delete a
file the database still points at.

1. Cloudflare dashboard → **R2** → create a bucket.
2. **Manage API tokens** → create a token with **Object Read & Write**, scoped
   to that bucket.
3. Put the account id, bucket name, access key id and secret in `R2_*`.

```bash
npm run storage:test
```

Uploads a file, reads it back, compares the bytes, signs a temporary URL and
deletes it. A missing bucket and a permissions failure are reported as such
rather than as a bare 404 or 403.

The generated storage key is used as the object key unchanged, so the bucket
mirrors the purposes: `event_banner/2026/…`, `registration_evidence/2026/…`.
Reads still go through `GET /files/:id` so access control applies; `signedUrl()`
exists on the driver for the day large private downloads should bypass the API.

**Google Drive.** `STORAGE_DRIVER=gdrive` stores uploads in a folder inside a
**Shared Drive**. It has to be a Shared Drive: a service account has no storage
quota of its own, so uploading into a personal My Drive fails outright. Setup:

1. In the Google Cloud console, create a project, enable the **Drive API**, and
   create a **service account** with a JSON key.
2. Save the key as `carisca-api/service-account.json` (gitignored), or paste it
   into `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` as JSON or base64.
3. Create a **Shared Drive** in Google Drive, and share it with the service
   account's `client_email` as **Content Manager**.
4. Make a folder in that Shared Drive and put its id — the last part of the
   folder URL — in `GOOGLE_DRIVE_FOLDER_ID`.

**If the folder is in a My Drive instead.** A service account owns no storage,
so it cannot own the files it creates and the upload fails on quota — being
allowed to write to the folder is not enough. The way round it is domain-wide
delegation: set `GOOGLE_DRIVE_IMPERSONATE_USER` to the folder's owner and every
call is made as them, so the files are theirs and use their quota. It needs a
Workspace admin to authorise the service account's numeric client id under
**Security → API controls → Domain-wide delegation** for the scope
`https://www.googleapis.com/auth/drive`. A Shared Drive is still the better
answer — files owned by a person disappear when that person's account is
closed.

Then check it before trusting it:

```bash
npm run storage:test
```

That authenticates, confirms the destination really is a writable folder in a
Shared Drive, uploads a file, reads it back, compares the bytes and deletes it.
The three failures that aren't obvious from the error text — quota, a 404
because the service account was never added to the drive, and a disabled API —
are explained in its output.

One consequence worth knowing: a Shared Drive is browsable, so anyone with
access can delete a file the database still points at. That reads as a clean
404 rather than a 500, and the row is deliberately left alone — it is the
record of what was uploaded, and treating a read failure as "delete the
metadata" would turn an outage into data loss.

### Notifications

An outbox. `notify()` writes a row inside the caller's transaction; a worker
dispatches later. A rolled-back registration cannot email anyone, and a mail
outage delays delivery without ever failing a registration.

Delivery is `npm run worker`. It claims batches with `SELECT … FOR UPDATE SKIP
LOCKED`, so several workers never send the same email twice, and retries on a
1m/5m/25m/2h backoff up to five attempts. A permanent SMTP rejection — a 5xx
reply or a refused mailbox — is failed immediately rather than retried, since
the answer will not change.

**Configuring mail.** `MAIL_DRIVER=log` (the default) writes each message to the
log and sends nothing, so the whole flow works with no mail account.
`MAIL_DRIVER=smtp` delivers for real and requires `SMTP_HOST`; use port 465 with
`SMTP_SECURE=true`, or 587 with `SMTP_SECURE=false` for STARTTLS. Credentials
are optional for a relay that authenticates by IP, but `SMTP_USER` and
`SMTP_PASSWORD` must be set together. Boot fails on a half-configured setup, and
production refuses to start on `MAIL_DRIVER=log` — silently delivering nothing
is worse than not starting.

Check the configuration before trusting it:

```bash
node scripts/send-test-email.js you@example.com
node scripts/send-test-email.js you@example.com registration_confirmed
```

It verifies the connection, renders a real template with sample data and sends.
The worker also verifies the transport at start-up and logs an error if the
relay is unreachable — it still starts, because the outbox holds mail safely
until the relay returns.

---

## Testing

```bash
npm test
```

80 tests, ~5s, against a real MySQL database (`carisca_dev_test`) built once by
`tests/helpers/global-setup.js` from the same migrations and seeders production
uses. The schema is not mocked — the constraints being verified (unique
indexes, FK actions, the audit triggers) live in it.

| Suite | Covers |
|---|---|
| `integration/authorization.test.js` | **The phase gate.** Every seeded role resolves to exactly its declared permission set, enforced over HTTP; revocation and deactivation take effect immediately. |
| `integration/auth.test.js` | Registration, verification, sign-in, refresh rotation with reuse detection, password reset. |
| `integration/audit.test.js` | Trigger-enforced immutability, secret scrubbing. |
| `unit/money.test.js` | Minor-unit conversion, per-currency exponents, float-safety. |

The authorization suite is the one to keep green above all others. A role
quietly gaining a permission is a privilege escalation, and that file is what
catches it.

---

## Environment

Every variable is declared and validated in `src/config/env.js`; boot fails
loudly on a missing or malformed value. See `.env.example`.

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must each be ≥32 characters and
**must differ**. Never commit `.env`.

---

## Conventions

- Times are UTC `DATETIME(3)`; events carry an IANA `timezone` column and local
  time is derived, never assumed. The connection is pinned to `+00:00`.
- Migrations and seeders are `.cjs` (sequelize-cli is CommonJS); runtime code is
  ESM. The two never load each other.
- Responses are always `{ success, message, data }`; errors always
  `{ success: false, message, error: { code }, requestId }`.
- Models never reach `res.json()` directly — serialisers decide the wire shape.
- Sort fields are matched against an allow-list, never interpolated.

---

## Next

**Week 1 — CPD.** `EventService` and the state machine, the registration
question builder, `RegistrationService` with locked capacity holds, the public
event pages' API, and the notification dispatcher worker.

**Blocking, and not a code task:** the Paystack and Stripe live-account
applications. Business verification routinely takes one to three weeks —
longer than the rest of the build. Start them now; develop against sandbox.
