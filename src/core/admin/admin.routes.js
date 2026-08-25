import { Router } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import {
  authenticate, loadPermissions, requirePermission, requireStaff,
} from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { ok, created, paginated } from '../../lib/response.js';
import {
  resolveOrder, offsetFor, searchAcross, pageMeta,
} from '../../lib/pagination.js';
import { serialiseUser } from '../users/user.serialiser.js';
import { registry } from '../rbac/rbac.service.js';
import { AuthorizationError } from '../../lib/errors.js';
import { record as auditRecord } from '../audit/audit.service.js';
import {
  createUser, updateUser, setUserRoles, resetUserPassword, findUser,
} from '../users/user-admin.service.js';
import {
  createUserSchema, updateUserSchema, setRolesSchema, adminResetPasswordSchema,
  auditQuerySchema, userQuerySchema,
} from './admin.validation.js';

const { User, Role, Permission, AuditLog, Department } = models;

const router = Router();

/**
 * Every admin route runs the same chain: authenticate, confirm staff, resolve
 * permissions, then require a specific one. The staff gate is a coarse filter
 * on the console as a whole; the permission is the actual authority.
 */
router.use(authenticate, requireStaff, loadPermissions);

// --- users -----------------------------------------------------------------
router.get('/users',
  requirePermission('users.view'),
  validate({ query: userQuerySchema }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order, q, status, role, isStaff } = req.validatedQuery;

      const where = { ...searchAcross(q, ['first_name', 'last_name', 'email', 'organization']) };
      if (status) where.status = status;
      if (isStaff !== undefined) where.is_staff = isStaff === 'true';

      // Narrows which users match, via a subquery, rather than putting the
      // condition on the join. A `where` on the include would also filter the
      // roles each row carries, so filtering by "manager" would render a
      // manager who is also event staff as holding only the one role.
      if (role) {
        where.id = {
          [Op.in]: literal(
            `(SELECT ur.user_id FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
               WHERE r.key = ${sequelize.escape(role)} AND r.deleted_at IS NULL)`,
          ),
        };
      }

      const { rows, count } = await User.findAndCountAll({
        where,
        include: [
          { model: Role, as: 'roles', through: { attributes: [] } },
          { model: Department, as: 'department' },
        ],
        order: resolveOrder(sort, order, {
          allowed: ['created_at', 'last_name', 'email', 'last_login_at', 'status'],
          fallback: 'created_at',
        }),
        ...offsetFor({ page, limit }),
        distinct: true,
      });

      return paginated(res, rows.map((u) => serialiseUser(u)), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

router.get('/users/:id',
  requirePermission('users.view'),
  async (req, res, next) => {
    try {
      return ok(res, serialiseUser(await findUser(req.params.id)));
    } catch (err) {
      return next(err);
    }
  });

router.post('/users',
  requirePermission('users.create'),
  validate({ body: createUserSchema }),
  async (req, res, next) => {
    try {
      const { user, welcomeEmailSent } = await createUser(req.body, {
        actor: { id: req.user.id, email: req.user.email },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return created(res, { ...serialiseUser(user), welcomeEmailSent }, 'Account created.');
    } catch (err) {
      return next(err);
    }
  });

router.patch('/users/:id',
  requirePermission('users.update'),
  validate({ body: updateUserSchema }),
  async (req, res, next) => {
    try {
      // Deactivating somebody is a heavier act than correcting their job title,
      // and carries its own permission. Both are reachable through this route,
      // so the status field is gated separately rather than by the route.
      if (req.body.status !== undefined && !req.permissions.has('users.deactivate')) {
        throw new AuthorizationError(
          'You do not have permission to change account status.',
          { required: ['users.deactivate'] },
        );
      }

      const user = await updateUser(req.params.id, req.body, {
        actor: { id: req.user.id, email: req.user.email },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return ok(res, serialiseUser(user), 'Saved.');
    } catch (err) {
      return next(err);
    }
  });

router.put('/users/:id/roles',
  requirePermission('rbac.manage'),
  validate({ body: setRolesSchema }),
  async (req, res, next) => {
    try {
      const user = await setUserRoles(req.params.id, req.body.roleKeys, {
        actor: { id: req.user.id, email: req.user.email },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return ok(res, serialiseUser(user), 'Roles updated.');
    } catch (err) {
      return next(err);
    }
  });

router.post('/users/:id/password',
  requirePermission('users.update'),
  validate({ body: adminResetPasswordSchema }),
  async (req, res, next) => {
    try {
      await resetUserPassword(req.params.id, req.body.password, {
        actor: { id: req.user.id, email: req.user.email },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return ok(res, null, 'Password set. Every existing session has been signed out.');
    } catch (err) {
      return next(err);
    }
  });

/** The department picker on the user form. */
router.get('/departments',
  requirePermission('users.view'),
  async (req, res, next) => {
    try {
      const departments = await Department.findAll({
        where: { is_active: true },
        order: [['name', 'ASC']],
      });

      return ok(res, departments.map((d) => ({
        id: String(d.id), name: d.name, code: d.code,
      })));
    } catch (err) {
      return next(err);
    }
  });

// --- roles and permissions --------------------------------------------------
router.get('/roles',
  requirePermission('rbac.view'),
  async (req, res, next) => {
    try {
      const roles = await Role.findAll({
        include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
        order: [['id', 'ASC']],
      });

      return ok(res, roles.map((r) => ({
        id: String(r.id),
        key: r.key,
        name: r.name,
        description: r.description,
        isSystem: !!r.is_system,
        permissions: r.permissions.map((p) => p.key).sort(),
      })));
    } catch (err) {
      return next(err);
    }
  });

router.get('/permissions',
  requirePermission('rbac.view'),
  async (req, res, next) => {
    try {
      const permissions = await Permission.findAll({ order: [['module', 'ASC'], ['key', 'ASC']] });

      // Grouped by module: the shape the admin UI's permission picker needs.
      const grouped = permissions.reduce((acc, p) => {
        (acc[p.module] ||= []).push({
          key: p.key, resource: p.resource, action: p.action, description: p.description,
        });
        return acc;
      }, {});

      return ok(res, { modules: grouped, total: permissions.length });
    } catch (err) {
      return next(err);
    }
  });

/** The seeded matrix, for comparing intent against what is actually granted. */
router.get('/rbac/matrix',
  requirePermission('rbac.view'),
  async (req, res, next) => {
    try {
      return ok(res, {
        roles: registry.roles.map((r) => ({
          key: r.key,
          name: r.name,
          permissions: r.permissions === '*' ? '*' : r.permissions,
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

// --- audit -----------------------------------------------------------------

/**
 * Turns the query string into a WHERE clause.
 *
 * `to` is inclusive of the whole day it names: a reviewer asking for "up to
 * the 14th" means the end of the 14th, and an exclusive bound silently drops
 * everything that happened that day.
 */
function auditWhere({ q, action, resourceType, actorId, from, to }) {
  const where = { ...searchAcross(q, ['action', 'resource_type', 'actor_email', 'resource_id']) };

  if (action) where.action = action;
  if (resourceType) where.resource_type = resourceType;
  if (actorId) where.actor_user_id = actorId;

  const range = {};
  if (from) {
    const start = new Date(`${from}T00:00:00.000Z`);
    if (!Number.isNaN(start.valueOf())) range[Op.gte] = start;
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999Z`);
    if (!Number.isNaN(end.valueOf())) range[Op.lte] = end;
  }
  if (Object.getOwnPropertySymbols(range).length) where.created_at = range;

  return where;
}

const ACTOR_INCLUDE = [{
  model: User, as: 'actor', attributes: ['id', 'first_name', 'last_name', 'email'], required: false,
}];

function serialiseAuditLog(l) {
  return {
    id: String(l.id),
    action: l.action,
    resourceType: l.resource_type,
    resourceId: l.resource_id,
    actor: l.actor
      ? { id: String(l.actor.id), name: `${l.actor.first_name} ${l.actor.last_name}`, email: l.actor.email }
      // A deleted actor, or a system action, still has the email captured at
      // the time — which is the whole point of denormalising it onto the row.
      : { id: null, name: null, email: l.actor_email },
    before: l.before,
    after: l.after,
    metadata: l.metadata,
    ip: l.ip,
    userAgent: l.user_agent,
    requestId: l.request_id,
    createdAt: l.created_at,
  };
}

router.get('/audit-logs',
  requirePermission('audit.view'),
  validate({ query: auditQuerySchema }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order } = req.validatedQuery;

      const { rows, count } = await AuditLog.findAndCountAll({
        where: auditWhere(req.validatedQuery),
        include: ACTOR_INCLUDE,
        order: resolveOrder(sort, order, {
          allowed: ['created_at', 'action', 'resource_type'],
          fallback: 'created_at',
        }),
        ...offsetFor({ page, limit }),
      });

      return paginated(res, rows.map(serialiseAuditLog), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

/**
 * The distinct values behind the filter dropdowns.
 *
 * Read from the log itself rather than a hard-coded list: actions are added by
 * every module that records one, and a filter that does not know about a new
 * action is a filter that hides it.
 */
router.get('/audit-logs/facets',
  requirePermission('audit.view'),
  async (req, res, next) => {
    try {
      const [actions, resourceTypes, actors] = await Promise.all([
        AuditLog.findAll({
          attributes: [[fn('DISTINCT', col('action')), 'action']],
          order: [['action', 'ASC']],
          raw: true,
        }),
        AuditLog.findAll({
          attributes: [[fn('DISTINCT', col('resource_type')), 'resource_type']],
          order: [['resource_type', 'ASC']],
          raw: true,
        }),
        AuditLog.findAll({
          attributes: ['actor_user_id', 'actor_email'],
          where: { actor_user_id: { [Op.ne]: null } },
          group: ['actor_user_id', 'actor_email'],
          order: [['actor_email', 'ASC']],
          raw: true,
        }),
      ]);

      return ok(res, {
        actions: actions.map((a) => a.action).filter(Boolean),
        resourceTypes: resourceTypes.map((r) => r.resource_type).filter(Boolean),
        actors: actors
          .filter((a) => a.actor_email)
          .map((a) => ({ id: String(a.actor_user_id), email: a.actor_email })),
      });
    } catch (err) {
      return next(err);
    }
  });

/**
 * CSV of the current filter, for handing an auditor a file.
 *
 * Capped rather than streamed: the whole point is a reviewable extract, and an
 * unbounded export of an append-only table is a way to exhaust memory. Taking
 * a copy is itself audited.
 */
router.get('/audit-logs/export',
  requirePermission('audit.view', 'reports.export'),
  validate({ query: auditQuerySchema }),
  async (req, res, next) => {
    try {
      const where = auditWhere(req.validatedQuery);
      const rows = await AuditLog.findAll({
        where,
        include: ACTOR_INCLUDE,
        order: [['created_at', 'DESC']],
        limit: 10_000,
      });

      const escape = (value) => {
        if (value === null || value === undefined) return '';
        const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const header = ['When', 'Action', 'Resource', 'Resource ID', 'Actor', 'Actor email', 'IP', 'Request ID', 'Before', 'After', 'Metadata'];
      const lines = [header.join(',')];

      for (const l of rows) {
        const entry = serialiseAuditLog(l);
        lines.push([
          entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
          entry.action,
          entry.resourceType,
          entry.resourceId,
          entry.actor.name,
          entry.actor.email,
          entry.ip,
          entry.requestId,
          entry.before,
          entry.after,
          entry.metadata,
        ].map(escape).join(','));
      }

      await auditRecord({
        actor: { id: req.user.id, email: req.user.email },
        action: 'audit.exported',
        resourceType: 'audit_log',
        metadata: { rows: rows.length, filters: req.validatedQuery },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // A BOM, so Excel opens UTF-8 names correctly instead of mangling them.
      return res.send(`﻿${lines.join('\r\n')}`);
    } catch (err) {
      return next(err);
    }
  });

export default router;
