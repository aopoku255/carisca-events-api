import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';

/**
 * Schemas for the administrative console. The password rule matches
 * auth.validation.js deliberately — a password an administrator sets must not
 * be weaker than one a participant chooses for themselves.
 */
const password = z.string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.');

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);

const STATUS = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']);

/** Fields shared by create and update. */
const profileFields = {
  prefix: z.string().trim().max(16).nullish(),
  middleName: z.string().trim().max(80).nullish(),
  suffix: z.string().trim().max(16).nullish(),
  phone: z.string().trim().max(32).nullish(),
  organization: z.string().trim().max(160).nullish(),
  jobTitle: z.string().trim().max(160).nullish(),
  countryCode: z.string().trim().length(2).toUpperCase().nullish(),
  city: z.string().trim().max(120).nullish(),
  stateProvince: z.string().trim().max(120).nullish(),
  timezone: z.string().trim().max(64).nullish(),
  departmentId: z.coerce.number().int().positive().nullish(),
  isStaff: z.boolean().optional(),
  status: STATUS.optional(),
};

export const createUserSchema = z.object({
  email,
  password,
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  roleKeys: z.array(z.string().trim().max(64)).max(20).default([]),
  ...profileFields,
}).strict();

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(80).optional(),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80).optional(),
  ...profileFields,
}).strict();

export const setRolesSchema = z.object({
  roleKeys: z.array(z.string().trim().max(64)).max(20),
}).strict();

export const adminResetPasswordSchema = z.object({ password }).strict();

/** Free-text search plus the facets the audit table filters on. */
export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(96).optional(),
  resourceType: z.string().trim().max(48).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  // Dates arrive as YYYY-MM-DD from a date input; `to` is treated as
  // inclusive of the whole day in the route rather than here.
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
});

export const userQuerySchema = paginationSchema.extend({
  status: STATUS.optional(),
  role: z.string().trim().max(64).optional(),
  isStaff: z.enum(['true', 'false']).optional(),
});

export default {
  createUserSchema,
  updateUserSchema,
  setRolesSchema,
  adminResetPasswordSchema,
  auditQuerySchema,
  userQuerySchema,
};
