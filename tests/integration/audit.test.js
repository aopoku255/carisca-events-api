import { jest } from '@jest/globals';
import { prepareDatabase, teardown, makeUser, models, sequelize } from '../helpers/setup.js';
import { record, scrub } from '../../src/core/audit/audit.service.js';

jest.setTimeout(60_000);

beforeAll(prepareDatabase);
afterAll(teardown);

describe('audit log immutability', () => {
  test('entries can be written and read', async () => {
    const actor = await makeUser({ roleKey: 'it_admin', isStaff: true });

    const entry = await record({
      actor: { id: actor.id, email: actor.email },
      action: 'test.action',
      resourceType: 'test',
      resourceId: 42,
      after: { field: 'value' },
      context: { ip: '127.0.0.1', requestId: '01HTESTREQUESTID0000000000' },
    });

    expect(entry).not.toBeNull();
    const found = await models.AuditLog.findByPk(entry.id);
    expect(found.action).toBe('test.action');
    expect(found.resource_id).toBe('42');
  });

  test('UPDATE is rejected by the database, not merely by convention', async () => {
    const entry = await record({ action: 'test.update', resourceType: 'test', resourceId: 1 });

    await expect(
      sequelize.query('UPDATE audit_logs SET action = :a WHERE id = :id', {
        replacements: { a: 'tampered', id: entry.id },
      }),
    ).rejects.toThrow(/append-only/i);

    const unchanged = await models.AuditLog.findByPk(entry.id);
    expect(unchanged.action).toBe('test.update');
  });

  test('DELETE is rejected by the database', async () => {
    const entry = await record({ action: 'test.delete', resourceType: 'test', resourceId: 2 });

    await expect(
      sequelize.query('DELETE FROM audit_logs WHERE id = :id', { replacements: { id: entry.id } }),
    ).rejects.toThrow(/append-only/i);

    expect(await models.AuditLog.findByPk(entry.id)).not.toBeNull();
  });

  test('deleting the actor preserves what they did', async () => {
    const actor = await makeUser({ roleKey: 'manager', isStaff: true });
    const entry = await record({
      actor: { id: actor.id, email: actor.email },
      action: 'test.actor_removal',
      resourceType: 'test',
      resourceId: 3,
    });

    // Hard delete, bypassing the paranoid soft-delete.
    await actor.destroy({ force: true });

    const found = await models.AuditLog.findByPk(entry.id);
    expect(found).not.toBeNull();
    expect(found.actor_user_id).toBeNull();
    // The email was denormalised precisely so the trail survives.
    expect(found.actor_email).toBe(actor.email);
  });
});

describe('secret scrubbing', () => {
  test('removes sensitive keys at any depth', () => {
    const cleaned = scrub({
      email: 'someone@example.test',
      password: 'hunter2',
      nested: { token_hash: 'abc', qr_token: 'xyz', keep: 'this' },
      list: [{ secret: 's3cret', fine: 1 }],
    });

    expect(cleaned.email).toBe('someone@example.test');
    expect(cleaned.password).toBe('[redacted]');
    expect(cleaned.nested.token_hash).toBe('[redacted]');
    expect(cleaned.nested.qr_token).toBe('[redacted]');
    expect(cleaned.nested.keep).toBe('this');
    expect(cleaned.list[0].secret).toBe('[redacted]');
    expect(cleaned.list[0].fine).toBe(1);
  });

  test('a password can never reach the audit table', async () => {
    const entry = await record({
      action: 'test.scrub',
      resourceType: 'user',
      resourceId: 1,
      before: { password: 'plaintext-oops', email: 'a@b.test' },
      after: { password_hash: '$argon2id$fake', email: 'a@b.test' },
    });

    const found = await models.AuditLog.findByPk(entry.id);
    expect(JSON.stringify(found.before)).not.toContain('plaintext-oops');
    expect(JSON.stringify(found.after)).not.toContain('argon2id');
    expect(found.before.email).toBe('a@b.test');
  });
});
