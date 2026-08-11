import { Router } from 'express';
import { models } from '../../database/models/index.js';
import {
  authenticate, loadPermissions, requirePermission, requireStaff,
} from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { ok, paginated } from '../../lib/response.js';
import {
  paginationSchema, resolveOrder, offsetFor, searchAcross, pageMeta,
} from '../../lib/pagination.js';
import { serialiseUser } from '../users/user.serialiser.js';
import { registry } from '../rbac/rbac.service.js';

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
  validate({ query: paginationSchema }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order, q } = req.validatedQuery;
      const { rows, count } = await User.findAndCountAll({
        where: searchAcross(q, ['first_name', 'last_name', 'email', 'organization']),
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
router.get('/audit-logs',
  requirePermission('audit.view'),
  validate({ query: paginationSchema }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order, q } = req.validatedQuery;
      const { rows, count } = await AuditLog.findAndCountAll({
        where: searchAcross(q, ['action', 'resource_type', 'actor_email']),
        include: [{ model: User, as: 'actor', attributes: ['id', 'first_name', 'last_name', 'email'] }],
        order: resolveOrder(sort, order, {
          allowed: ['created_at', 'action', 'resource_type'],
          fallback: 'created_at',
        }),
        ...offsetFor({ page, limit }),
      });

      return paginated(res, rows.map((l) => ({
        id: String(l.id),
        action: l.action,
        resourceType: l.resource_type,
        resourceId: l.resource_id,
        actor: l.actor
          ? { id: String(l.actor.id), name: `${l.actor.first_name} ${l.actor.last_name}`, email: l.actor.email }
          : { email: l.actor_email },
        before: l.before,
        after: l.after,
        metadata: l.metadata,
        ip: l.ip,
        requestId: l.request_id,
        createdAt: l.created_at,
      })), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

export default router;
