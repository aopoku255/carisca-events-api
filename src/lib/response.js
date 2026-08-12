/**
 * One response shape for the whole API. Frontend and mobile clients can rely on
 * `success`, `message` and `data` being present on every route, and on errors
 * carrying a stable machine-readable `error.code`.
 */
export function ok(res, data = null, message = 'OK', meta = undefined) {
  const body = { success: true, message, data };
  if (meta !== undefined) body.meta = meta;
  return res.json(body);
}

export function created(res, data = null, message = 'Created') {
  return res.status(201).json({ success: true, message, data });
}

export function noContent(res) {
  return res.status(204).send();
}

export function paginated(res, items, { page, limit, total }, message = 'OK') {
  return res.json({
    success: true,
    message,
    data: items,
    meta: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      // Both directions, because a pager needs to know whether to render a
      // "previous" control and cannot infer that from hasMore alone.
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
  });
}

export function fail(res, { status = 400, code = 'ERROR', message, details = null, requestId }) {
  const body = { success: false, message, error: { code } };
  if (details) body.error.details = details;
  if (requestId) body.requestId = requestId;
  return res.status(status).json(body);
}
