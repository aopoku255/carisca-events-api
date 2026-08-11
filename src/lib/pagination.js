import { z } from 'zod';
import { Op } from 'sequelize';

/**
 * Server-side paging, sorting and search for every admin table. Sort fields
 * are matched against an explicit allow-list rather than interpolated, so a
 * query parameter can never reach the ORDER BY clause unchecked.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().trim().max(64).optional(),
  order: z.enum(['asc', 'desc', 'ASC', 'DESC']).default('desc'),
  q: z.string().trim().max(200).optional(),
});

export function resolveOrder(sort, order, { allowed, fallback }) {
  const field = allowed.includes(sort) ? sort : fallback;
  const direction = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return [[field, direction]];
}

export function offsetFor({ page, limit }) {
  return { limit, offset: (page - 1) * limit };
}

/** Case-insensitive contains across several columns. */
export function searchAcross(term, fields) {
  if (!term) return undefined;
  return { [Op.or]: fields.map((f) => ({ [f]: { [Op.like]: `%${term}%` } })) };
}

export function pageMeta({ page, limit }, total) {
  return { page, limit, total };
}

export default { paginationSchema, resolveOrder, offsetFor, searchAcross, pageMeta };
