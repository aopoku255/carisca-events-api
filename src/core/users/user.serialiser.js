/**
 * One place that decides what a user looks like over the wire. Nothing else
 * should hand a Sequelize instance to res.json(): the model's shape is a
 * database concern and must not leak into the API contract.
 */
export function serialiseUser(user, { permissions = null } = {}) {
  if (!user) return null;

  const out = {
    id: String(user.id),
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    fullName: `${user.first_name} ${user.last_name}`.trim(),
    phone: user.phone ?? null,
    countryCode: user.country_code ?? null,
    organization: user.organization ?? null,
    jobTitle: user.job_title ?? null,
    timezone: user.timezone ?? null,
    status: user.status,
    isStaff: !!user.is_staff,
    emailVerified: !!user.email_verified_at,
    departmentId: user.department_id ? String(user.department_id) : null,
    lastLoginAt: user.last_login_at ?? null,
    createdAt: user.created_at,
  };

  if (user.roles) {
    out.roles = user.roles.map((r) => ({ key: r.key, name: r.name }));
  }
  if (permissions) {
    out.permissions = [...permissions].sort();
  }
  if (user.department) {
    out.department = { id: String(user.department.id), name: user.department.name, code: user.department.code };
  }

  return out;
}

export default { serialiseUser };
