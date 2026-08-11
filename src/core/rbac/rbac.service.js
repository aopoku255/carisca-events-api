import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/models/index.js';
import { getRedis } from '../../config/redis.js';
import env from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';

/**
 * Effective permissions are resolved per request and cached for a short window,
 * never carried inside the access token. That is what makes "revoke this
 * admin's rights" and "disable this account" take effect within seconds rather
 * than whenever their token happens to expire.
 */

const registryPath = fileURLToPath(new URL('./permissions.json', import.meta.url));
export const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

/** Every permission key known to the application. */
export const PERMISSIONS = Object.freeze(
  Object.fromEntries(registry.permissions.map((p) => [p.key, p.key])),
);

const ALL_KEYS = new Set(registry.permissions.map((p) => p.key));

/**
 * Guards against typos at the call site. A route asking for a permission that
 * does not exist would otherwise silently deny everyone, or worse, be quietly
 * dropped from an `every()` check.
 */
export function assertKnownPermission(key) {
  if (!ALL_KEYS.has(key)) {
    throw new AppError(
      `Unknown permission "${key}". Add it to src/core/rbac/permissions.json and re-seed.`,
      { code: 'UNKNOWN_PERMISSION' },
    );
  }
  return key;
}

const cacheKey = (userId) => `perm:v1:${userId}`;

/** Reads straight from the database — the authority, cache aside. */
export async function loadPermissionsFromDb(userId) {
  const rows = await sequelize.query(
    `SELECT DISTINCT p.key
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p        ON p.id = rp.permission_id
       JOIN roles r              ON r.id = ur.role_id
      WHERE ur.user_id = :userId
        AND r.deleted_at IS NULL`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.key);
}

export async function getPermissions(userId) {
  const key = cacheKey(userId);

  try {
    const cached = await getRedis().get(key);
    if (cached) return new Set(JSON.parse(cached));
  } catch (err) {
    // A cache miss caused by Redis being unavailable must not deny access;
    // fall through to the database, which is always the source of truth.
    logger.warn({ err: err.message, userId }, 'permission cache read failed');
  }

  const keys = await loadPermissionsFromDb(userId);

  try {
    await getRedis().set(key, JSON.stringify(keys), 'EX', env.PERMISSION_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'permission cache write failed');
  }

  return new Set(keys);
}

/** Called whenever a user's roles change, or a role's permissions change. */
export async function invalidateUser(userId) {
  try {
    await getRedis().del(cacheKey(userId));
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'permission cache invalidation failed');
  }
}

/** Called when a role is edited: every holder of that role must be flushed. */
export async function invalidateRole(roleId) {
  const rows = await sequelize.query(
    'SELECT user_id FROM user_roles WHERE role_id = :roleId',
    { replacements: { roleId }, type: QueryTypes.SELECT },
  );
  await Promise.all(rows.map((r) => invalidateUser(r.user_id)));
  return rows.length;
}

export function has(permissionSet, key) {
  return permissionSet.has(assertKnownPermission(key));
}

export function hasAny(permissionSet, keys) {
  return keys.some((k) => permissionSet.has(assertKnownPermission(k)));
}

export function hasAll(permissionSet, keys) {
  return keys.every((k) => permissionSet.has(assertKnownPermission(k)));
}

/**
 * Reconciles permissions.json into the database on boot. Additive only — it
 * never deletes, because a permission removed from the registry may still be
 * referenced by a custom role an administrator created.
 */
export async function syncPermissions() {
  const existing = await sequelize.query('SELECT `key` FROM permissions', { type: QueryTypes.SELECT });
  const known = new Set(existing.map((r) => r.key));
  const missing = registry.permissions.filter((p) => !known.has(p.key));

  if (!missing.length) return { added: 0 };

  const now = new Date();
  await sequelize.getQueryInterface().bulkInsert(
    'permissions',
    missing.map((p) => ({
      key: p.key,
      module: p.module,
      resource: p.resource,
      action: p.action,
      description: p.description || null,
      created_at: now,
      updated_at: now,
    })),
  );

  logger.info({ added: missing.map((p) => p.key) }, 'permissions synchronised');
  return { added: missing.length };
}

export default {
  PERMISSIONS,
  registry,
  getPermissions,
  loadPermissionsFromDb,
  invalidateUser,
  invalidateRole,
  has,
  hasAny,
  hasAll,
  syncPermissions,
  assertKnownPermission,
};
