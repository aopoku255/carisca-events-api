import { missingProfileFields, isProfileComplete } from '../../src/core/users/profile-completeness.js';

const complete = {
  phone: '+233555000111',
  country_code: 'GH',
  organization: 'KNUST',
  job_title: 'Lecturer',
  position_id: 1,
  sector_id: 1,
};

describe('missingProfileFields', () => {
  test('a fully filled-in profile has nothing missing', () => {
    expect(missingProfileFields(complete)).toEqual([]);
    expect(isProfileComplete(complete)).toBe(true);
  });

  test('null, undefined and empty string all count as missing', () => {
    expect(missingProfileFields({ ...complete, phone: null }).map((f) => f.key)).toContain('phone');
    expect(missingProfileFields({ ...complete, organization: undefined }).map((f) => f.key)).toContain('organization');
    expect(missingProfileFields({ ...complete, job_title: '' }).map((f) => f.key)).toContain('job_title');
  });

  test('reports every missing field, not just the first', () => {
    const bare = {
      ...complete, phone: null, country_code: null, position_id: null,
    };
    expect(missingProfileFields(bare).map((f) => f.key).sort()).toEqual(['country_code', 'phone', 'position_id']);
    expect(isProfileComplete(bare)).toBe(false);
  });

  test('zero is a valid id, not a missing one', () => {
    // FK ids are never actually 0 in this schema, but the check should key
    // off nullishness/emptiness, not falsiness, so a future 0-valued id
    // (or any other falsy-but-real value) is never misreported as missing.
    expect(missingProfileFields({ ...complete, position_id: 0 })).toEqual([]);
  });
});
