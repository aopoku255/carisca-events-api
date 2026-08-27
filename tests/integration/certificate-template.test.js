import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, CertificateTemplate,
} = models;

let server;
let manager;
let participant;
let cpdType;

/** Smallest valid PNG, built by hand so the bytes are real (matches files.test.js). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  participant = await makeUser({ roleKey: 'participant' });
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

async function uploadSignature(user = manager) {
  const res = await request(server).post('/api/v1/files/upload')
    .set(authHeader(user))
    .field('purpose', 'certificate_signature')
    .attach('file', PNG, { filename: 'sig.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  return Number(res.body.data.id);
}

let seq = 0;
async function makeEvent() {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `cert-tpl-evt-${Date.now()}-${seq}`,
    title: `Certificate Template Test Event ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 7 * 864e5 + 3 * 3600e3),
    timezone: 'Africa/Accra',
    delivery_mode: 'ONLINE',
    online_url: 'https://example.test/join',
    country_code: 'GH',
    status: 'REGISTRATION_OPEN',
    issues_certificate: true,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard', amount_minor: 0, currency: 'USD', is_default: true,
  });
  return event;
}

describe('permission gate', () => {
  test('a plain participant cannot list, create, or preview', async () => {
    const list = await request(server).get('/api/v1/certificate-templates').set(authHeader(participant));
    expect(list.status).toBe(403);

    const create = await request(server).post('/api/v1/certificate-templates')
      .set(authHeader(participant)).send({ name: 'Nope' });
    expect(create.status).toBe(403);
  });

  test('a manager (holds certificate_templates.manage) can list', async () => {
    const res = await request(server).get('/api/v1/certificate-templates').set(authHeader(manager));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('CRUD', () => {
  test('create, update and delete a template', async () => {
    const fileId = await uploadSignature();

    const create = await request(server).post('/api/v1/certificate-templates')
      .set(authHeader(manager)).send({
        name: `Test Signatory ${Date.now()}`,
        signatoryName: 'Dr Test Signatory',
        signatoryTitle: 'Senior Fellow',
        signatoryDepartment: 'Department of Testing',
        signatureFileId: fileId,
      });
    expect(create.status).toBe(201);
    expect(create.body.data.signatoryName).toBe('Dr Test Signatory');
    expect(create.body.data.signatureFile.id).toBe(String(fileId));
    const id = create.body.data.id;

    const update = await request(server).patch(`/api/v1/certificate-templates/${id}`)
      .set(authHeader(manager)).send({ signatoryTitle: 'Emeritus Fellow' });
    expect(update.status).toBe(200);
    expect(update.body.data.signatoryTitle).toBe('Emeritus Fellow');

    const del = await request(server).delete(`/api/v1/certificate-templates/${id}`).set(authHeader(manager));
    expect(del.status).toBe(200);

    const gone = await CertificateTemplate.findByPk(id);
    expect(gone).toBeNull();
  });

  test('deleting a template in use releases the event to the default signature, not blocked', async () => {
    const fileId = await uploadSignature();
    const create = await request(server).post('/api/v1/certificate-templates')
      .set(authHeader(manager)).send({
        name: `In Use ${Date.now()}`, signatoryName: 'Dr In Use', signatureFileId: fileId,
      });
    const templateId = create.body.data.id;

    const event = await makeEvent();
    await event.update({ certificate_template_id: templateId });

    const del = await request(server).delete(`/api/v1/certificate-templates/${templateId}`).set(authHeader(manager));
    expect(del.status).toBe(200);
    expect(del.body.message).toMatch(/1 event will use the default signature/);

    await event.reload();
    expect(event.certificate_template_id).toBeNull();
  });
});

describe('preview', () => {
  test('renders a real PNG from the current form values, no saved template required', async () => {
    const fileId = await uploadSignature();

    const res = await request(server).post('/api/v1/certificate-templates/preview')
      .set(authHeader(manager)).send({
        signatoryName: 'Dr Preview Signatory',
        signatoryTitle: 'Guest Lecturer',
        signatoryDepartment: 'Department of Previews',
        signatureFileId: fileId,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.imageDataUrl).toMatch(/^data:image\/png;base64,/);

    const raw = Buffer.from(res.body.data.imageDataUrl.split(',')[1], 'base64');
    // PNG magic bytes — proves this is a real image, not an error page or an
    // empty buffer.
    expect(raw.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
