import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

/**
 * The Drive driver against a stubbed API client. What is worth pinning down
 * here is the handful of details that make a real Shared Drive integration
 * work or silently not: supportsAllDrives on every call, the returned file id
 * becoming the storage key, and a 404 being reported as missing rather than
 * exploding.
 */

const filesCreate = jest.fn();
const filesGet = jest.fn();
const filesDelete = jest.fn();
const GoogleAuthMock = jest.fn();

jest.unstable_mockModule('@googleapis/drive', () => ({
  drive: jest.fn(() => ({
    files: { create: filesCreate, get: filesGet, delete: filesDelete },
  })),
  auth: { GoogleAuth: GoogleAuthMock },
}));

process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-abc';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = JSON.stringify({
  client_email: 'carisca-storage@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----fake-----END PRIVATE KEY-----',
});

const { createDriveDriver } = await import('../../src/core/files/drivers/gdrive.js');

const notFound = () => Object.assign(new Error('File not found: xyz'), { code: 404 });

let driver;

beforeEach(() => {
  jest.clearAllMocks();
  driver = createDriveDriver();
  filesCreate.mockResolvedValue({ data: { id: 'drive-file-1' } });
});

describe('uploading', () => {
  test('returns the Drive file id as the storage key, not the path it was given', async () => {
    const result = await driver.put('event_banner/2026/abc.png', Buffer.from('png'), {
      mimeType: 'image/png',
    });

    expect(result).toEqual({ key: 'drive-file-1' });
  });

  test('uploads into the configured folder with supportsAllDrives set', async () => {
    await driver.put('event_banner/2026/abc.png', Buffer.from('png'), { mimeType: 'image/png' });

    expect(filesCreate).toHaveBeenCalledWith(expect.objectContaining({
      supportsAllDrives: true,
      requestBody: expect.objectContaining({
        parents: ['folder-abc'],
        // Drive has no folders in a key, so the path is flattened into a name.
        name: 'event_banner_2026_abc.png',
        appProperties: { cariscaKey: 'event_banner/2026/abc.png' },
      }),
      media: expect.objectContaining({ mimeType: 'image/png' }),
    }));
  });

  test('fails loudly if Drive returns no file id rather than storing an empty key', async () => {
    filesCreate.mockResolvedValue({ data: {} });

    await expect(driver.put('k.png', Buffer.from('x'), {})).rejects.toThrow(/no file id/i);
  });

  test('accepts a base64-encoded service account key', async () => {
    const encoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON).toString('base64');
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = encoded;
    jest.resetModules();

    const { createDriveDriver: fresh } = await import('../../src/core/files/drivers/gdrive.js');
    // Constructing and using it is the assertion: a bad key throws on first use.
    await expect(fresh().put('k.png', Buffer.from('x'), {})).resolves.toBeDefined();
  });
});

describe('reading', () => {
  test('streams by file id', async () => {
    filesGet.mockResolvedValue({ data: Readable.from([Buffer.from('image-bytes')]) });

    const stream = await driver.stream('drive-file-1');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString()).toBe('image-bytes');
    expect(filesGet).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'drive-file-1', alt: 'media', supportsAllDrives: true }),
      expect.objectContaining({ responseType: 'stream' }),
    );
  });

  test('buffers by file id', async () => {
    filesGet.mockResolvedValue({ data: Buffer.from('image-bytes') });

    await expect(driver.buffer('drive-file-1')).resolves.toEqual(Buffer.from('image-bytes'));
  });

  test('reports a file deleted from the Drive UI as missing, so callers can 404', async () => {
    filesGet.mockRejectedValue(notFound());

    const err = await driver.stream('gone').catch((e) => e);

    expect(err.notFound).toBe(true);
    expect(err.name).toBe('DriveFileMissingError');
  });

  test('does not disguise a real failure as a missing file', async () => {
    filesGet.mockRejectedValue(Object.assign(new Error('backend error'), { code: 500 }));

    const err = await driver.stream('drive-file-1').catch((e) => e);

    expect(err.notFound).toBeUndefined();
    expect(err.message).toBe('backend error');
  });
});

describe('deleting', () => {
  test('treats an already-deleted file as success', async () => {
    filesDelete.mockRejectedValue(notFound());

    await expect(driver.remove('gone')).resolves.toBeUndefined();
  });

  test('still raises anything that is not a 404', async () => {
    filesDelete.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 403 }));

    await expect(driver.remove('drive-file-1')).rejects.toThrow(/permission denied/);
  });
});

describe('verify', () => {
  const folder = (over = {}) => ({
    data: {
      id: 'folder-abc',
      name: 'CARISCA Uploads',
      mimeType: 'application/vnd.google-apps.folder',
      driveId: 'shared-drive-1',
      capabilities: { canAddChildren: true },
      ...over,
    },
  });

  test('passes for a writable folder in a Shared Drive', async () => {
    filesGet.mockResolvedValue(folder());

    await expect(driver.verify()).resolves.toEqual({
      folder: 'CARISCA Uploads', driveId: 'shared-drive-1', actingAs: null,
    });
  });

  test('rejects a folder in a personal My Drive — uploads there would fail on quota', async () => {
    filesGet.mockResolvedValue(folder({ driveId: undefined }));

    await expect(driver.verify()).rejects.toThrow(/Shared Drive/i);
  });

  test('accepts a My Drive folder when impersonating its owner, whose quota it uses', async () => {
    process.env.GOOGLE_DRIVE_IMPERSONATE_USER = 'media@carisca.knust.edu.gh';
    jest.resetModules();

    const { createDriveDriver: fresh } = await import('../../src/core/files/drivers/gdrive.js');
    filesGet.mockResolvedValue(folder({ driveId: undefined }));

    try {
      await expect(fresh().verify()).resolves.toMatchObject({
        driveId: null, actingAs: 'media@carisca.knust.edu.gh',
      });
    } finally {
      delete process.env.GOOGLE_DRIVE_IMPERSONATE_USER;
      jest.resetModules();
    }
  });

  test('rejects a folder the service account cannot write to', async () => {
    filesGet.mockResolvedValue(folder({ capabilities: { canAddChildren: false } }));

    await expect(driver.verify()).rejects.toThrow(/Content Manager/i);
  });

  test('rejects an id that points at a file rather than a folder', async () => {
    filesGet.mockResolvedValue(folder({ mimeType: 'image/png' }));

    await expect(driver.verify()).rejects.toThrow(/not a folder/i);
  });
});
