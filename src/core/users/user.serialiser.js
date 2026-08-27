/**
 * One place that decides what a user looks like over the wire. Nothing else
 * should hand a Sequelize instance to res.json(): the model's shape is a
 * database concern and must not leak into the API contract.
 */
export function serialiseUser(user, { permissions = null } = {}) {
  if (!user) return null;

  // Prefix and suffix belong on a certificate; the plain full name does not
  // carry them, so both forms are exposed rather than reassembled per caller.
  const displayName = [user.prefix, user.first_name, user.middle_name, user.last_name, user.suffix]
    .filter(Boolean).join(' ');

  const out = {
    id: String(user.id),
    email: user.email,
    prefix: user.prefix ?? null,
    firstName: user.first_name,
    middleName: user.middle_name ?? null,
    lastName: user.last_name,
    suffix: user.suffix ?? null,
    fullName: `${user.first_name} ${user.last_name}`.trim(),
    displayName,
    gender: user.gender ?? null,
    phone: user.phone ?? null,
    countryCode: user.country_code ?? null,
    city: user.city ?? null,
    stateProvince: user.state_province ?? null,
    organization: user.organization ?? null,
    jobTitle: user.job_title ?? null,
    timezone: user.timezone ?? null,
    emailOptOut: !!user.email_opt_out,
    status: user.status,
    isStaff: !!user.is_staff,
    emailVerified: !!user.email_verified_at,
    departmentId: user.department_id ? String(user.department_id) : null,
    // Raw ids, always present — unlike `position`/`sector` below, which only
    // appear when the caller eagerly loaded those associations. Cheap (no
    // extra query, the FK is already on the row) and it's what registration's
    // profile-completeness check needs without forcing every authenticated
    // request to join two more tables just to answer a yes/no.
    positionId: user.position_id ? String(user.position_id) : null,
    sectorId: user.sector_id ? String(user.sector_id) : null,
    lastLoginAt: user.last_login_at ?? null,
    // `timestamps: true` names this attribute createdAt even under
    // `underscored: true` — that option renames the column, not the attribute.
    // Reading user.created_at alone returned undefined on every response.
    createdAt: user.createdAt ?? user.created_at ?? null,
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
  if (user.position) {
    out.position = { key: user.position.key, label: user.position.label };
  }
  if (user.sector) {
    out.sector = { key: user.sector.key, label: user.sector.label };
  }
  if (user.country) {
    // Continent is derived here rather than stored on the user, so it can
    // never contradict the country.
    out.country = { code: user.country.iso2, name: user.country.name, region: user.country.region };
  }

  return out;
}

export default { serialiseUser };
