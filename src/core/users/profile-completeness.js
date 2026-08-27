/**
 * What "finish your profile before registering" means, concretely. Name and
 * email are already required at signup; these are the fields signup leaves
 * optional but a real registration needs — who someone is, where they work,
 * and how to reach them. Mirrored in `carisca-web`'s register page (which
 * checks this before the form ever renders) and `ProfileForm.tsx` (which
 * marks the same fields required) — nothing here is enforced twice by
 * accident, both sides are describing the same rule.
 */
export const REQUIRED_PROFILE_FIELDS = [
  { key: 'phone', label: 'Phone number' },
  { key: 'country_code', label: 'Country' },
  { key: 'organization', label: 'Organization' },
  { key: 'job_title', label: 'Job title' },
  { key: 'position_id', label: 'Position' },
  { key: 'sector_id', label: 'Sector' },
];

/** @returns {{label: string, key: string}[]} whichever required fields are still empty. */
export function missingProfileFields(user) {
  return REQUIRED_PROFILE_FIELDS.filter(({ key }) => {
    const value = user[key];
    return value === null || value === undefined || value === '';
  });
}

export function isProfileComplete(user) {
  return missingProfileFields(user).length === 0;
}

export default { REQUIRED_PROFILE_FIELDS, missingProfileFields, isProfileComplete };
