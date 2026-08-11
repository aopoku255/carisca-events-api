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
| Test suite | ✅ 80 tests |
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

### Audit log

Append-only, enforced by MySQL triggers that raise `SQLSTATE 45000` on UPDATE
or DELETE — not by convention. Secrets are scrubbed from `before`/`after`
before they are written. Deleting a user nulls `actor_user_id` but keeps the
denormalised `actor_email`, so the trail survives.

### Notifications

An outbox. `notify()` writes a row inside the caller's transaction; a worker
dispatches later. A rolled-back registration cannot email anyone, and a mail
outage delays delivery without ever failing a registration.

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
