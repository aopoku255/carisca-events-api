import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import { sniffMime } from '../../src/core/files/storage.service.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, File } = models;

let server;
let manager;

/** Smallest valid files of each type, built by hand so the bytes are real. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const upload = (user, buffer, name, purpose, contentType = 'image/png') => request(server)
  .post('/api/v1/files/upload')
  .set(authHeader(user))
  .field('purpose', purpose)
  .attach('file', buffer, { filename: name, contentType });

describe('type sniffing', () => {
  test('identifies files by their bytes', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(SVG)).toBe('image/svg+xml');
    expect(sniffMime(Buffer.from('just some text that is long enough'))).toBeNull();
  });
});

describe('uploading a banner', () => {
  test('a manager can upload a PNG and gets a URL back', async () => {
    const res = await upload(manager, PNG, 'banner.png', 'event_banner');

    expect(res.status).toBe(201);
    expect(res.body.data.mimeType).toBe('image/png');
    expect(res.body.data.url).toMatch(/^\/files\/\d+$/);
    expect(res.body.data.visibility).toBe('PUBLIC');
  });

  /**
   * The declared Content-Type is supplied by the uploader. A script renamed to
   * .png arrives claiming image/png, so only the bytes may decide.
   */
  test('a script disguised as a PNG is refused', async () => {
    const evil = Buffer.from('<?php system($_GET["c"]); ?>' + ' '.repeat(64));
    const res = await upload(manager, evil, 'innocent.png', 'event_banner', 'image/png');

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/not recognised/i);
    expect(await File.count({ where: { original_name: 'innocent.png' } })).toBe(0);
  });

  test('a PDF is refused where only images are allowed', async () => {
    const res = await upload(manager, PDF, 'doc.pdf', 'event_banner', 'application/pdf');

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/application\/pdf files are not accepted/);
  });

  test('an oversized file is refused with the limit stated', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 0)]);
    const res = await upload(manager, huge, 'big.png', 'event_banner');

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/too large.*5MB/i);
  });

  test('an unknown purpose is refused', async () => {
    const res = await upload(manager, PNG, 'x.png', 'whatever_i_like');
    expect(res.status).toBe(422);
  });

  test('the stored name cannot escape the storage root', async () => {
    const res = await upload(manager, PNG, '../../../../etc/passwd.png', 'event_banner');
    expect(res.status).toBe(201);

    const file = await File.findByPk(res.body.data.id);
    // The key is generated, never derived from what was sent.
    expect(file.storage_key).toMatch(/^event_banner\/\d{4}\/[0-9a-f]{32}\.png$/);
    expect(file.storage_key).not.toContain('..');
  });

  test('uploads are audited', async () => {
    const res = await upload(manager, PNG, 'audited.png', 'event_banner');
    const entry = await models.AuditLog.findOne({
      where: { action: 'file.uploaded', resource_id: String(res.body.data.id) },
    });
    expect(entry).toBeTruthy();
    expect(entry.after.purpose).toBe('event_banner');
  });
});

describe('serving files', () => {
  let publicId;
  let privateId;

  beforeAll(async () => {
    const a = await upload(manager, PNG, 'public.png', 'event_banner');
    publicId = a.body.data.id;
    const b = await upload(manager, PDF, 'private.pdf', 'registration_evidence', 'application/pdf');
    privateId = b.body.data.id;
  });

  test('a public banner is served to anyone, with the verified type', async () => {
    const res = await request(server).get(`/api/v1/files/${publicId}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    // The browser must not second-guess a type we verified on upload.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/public/);
  });

  test('a private file is invisible to an anonymous caller', async () => {
    // 404 rather than 403 — whether it exists is itself information.
    expect((await request(server).get(`/api/v1/files/${privateId}`)).status).toBe(404);
  });

  test('a private file is invisible to an unrelated participant', async () => {
    const stranger = await makeUser({ roleKey: 'participant' });
    expect((await request(server).get(`/api/v1/files/${privateId}`)
      .set(authHeader(stranger))).status).toBe(404);
  });

  test('the uploader can read their own private file', async () => {
    expect((await request(server).get(`/api/v1/files/${privateId}`)
      .set(authHeader(manager))).status).toBe(200);
  });

  test('a private file is never cached', async () => {
    const res = await request(server).get(`/api/v1/files/${privateId}`).set(authHeader(manager));
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('an SVG is sent as a download, never rendered inline', async () => {
    const res = await upload(manager, SVG, 'logo.svg', 'organization_logo', 'image/svg+xml');
    expect(res.status).toBe(201);

    const served = await request(server).get(`/api/v1/files/${res.body.data.id}`);
    // SVG can carry script; rendering it inline from our origin would run it.
    expect(served.headers['content-disposition']).toMatch(/^attachment/);
  });
});

describe('permissions', () => {
  test('a participant cannot upload', async () => {
    const participant = await makeUser({ roleKey: 'participant' });
    expect((await upload(participant, PNG, 'x.png', 'event_banner')).status).toBe(403);
  });

  test('anonymous callers cannot upload', async () => {
    expect((await request(server).post('/api/v1/files/upload')
      .field('purpose', 'event_banner')
      .attach('file', PNG, 'x.png')).status).toBe(401);
  });

  test('deleting needs files.manage', async () => {
    const res = await upload(manager, PNG, 'deleteme.png', 'event_banner');
    const staff = await makeUser({ roleKey: 'event_staff', isStaff: true });

    expect((await request(server).delete(`/api/v1/files/${res.body.data.id}`)
      .set(authHeader(staff))).status).toBe(403);
  });
});

describe('an event banner', () => {
  test('is attached on create and appears on the public page', async () => {
    const director = await makeUser({ roleKey: 'director', isStaff: true });
    const uploaded = await upload(manager, PNG, 'cpd-banner.png', 'event_banner');

    const create = await request(server).post('/api/v1/cpd/events')
      .set(authHeader(manager))
      .send({
        title: `Banner CPD ${Date.now()}`,
        startAt: new Date(Date.now() + 30 * 864e5).toISOString(),
        endAt: new Date(Date.now() + 31 * 864e5).toISOString(),
        deliveryMode: 'OFFLINE',
        venue: 'KNUST',
        countryCode: 'GH',
        bannerFileId: Number(uploaded.body.data.id),
      });

    expect(create.status).toBe(201);
    expect(create.body.data.banner.url).toBe(`/files/${uploaded.body.data.id}`);

    const id = create.body.data.id;
    await request(server).put(`/api/v1/cpd/events/${id}/prices`).set(authHeader(manager))
      .send({ prices: [{ label: 'Free', amount: '0', currency: 'GHS', isDefault: true }] });
    await request(server).post(`/api/v1/cpd/events/${id}/publish`).set(authHeader(director)).send({});

    const publicView = await request(server).get(`/api/v1/events/${create.body.data.slug}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.data.banner.url).toBe(`/files/${uploaded.body.data.id}`);

    // And it is genuinely fetchable without an account.
    expect((await request(server).get(`/api/v1${publicView.body.data.banner.url}`)).status).toBe(200);
  });

  test('can be removed by setting it to null', async () => {
    const uploaded = await upload(manager, PNG, 'temp.png', 'event_banner');
    const type = await EventType.findOne({ where: { key: 'cpd' } });
    const event = await Event.create({
      event_type_id: type.id,
      slug: `banner-clear-${Date.now()}`,
      title: 'Banner clearing',
      start_at: new Date(), end_at: new Date(),
      banner_file_id: uploaded.body.data.id,
      status: 'DRAFT',
    });
    await EventPrice.create({
      event_id: event.id, tier: 'standard', label: 'Free',
      amount_minor: 0, currency: 'GHS', is_default: true,
    });

    const res = await request(server).patch(`/api/v1/cpd/events/${event.id}`)
      .set(authHeader(manager)).send({ bannerFileId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.banner).toBeNull();
  });
});
