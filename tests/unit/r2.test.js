import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

/**
 * The R2 driver against a stubbed S3 client. R2 speaks the S3 API, so what is
 * worth pinning down is our end of the contract: the storage key is used
 * verbatim, a missing object is reported as missing rather than thrown raw,
 * and the endpoint is derived correctly from the account id.
 */

const send = jest.fn();
const destroy = jest.fn();
const S3ClientMock = jest.fn(function S3Client(config) {
  this.config = config;
  this.send = send;
  this.destroy = destroy;
});

// Commands are recorded as plain objects so assertions can read their input.
const command = (name) => jest.fn(function Command(input) {
  this.constructor = { name };
  this.name = name;
  this.input = input;
});

const getSignedUrlMock = jest.fn();

jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: S3ClientMock,
  PutObjectCommand: command('PutObjectCommand'),
  GetObjectCommand: command('GetObjectCommand'),
  DeleteObjectCommand: command('DeleteObjectCommand'),
  HeadBucketCommand: command('HeadBucketCommand'),
}));

jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

process.env.R2_ACCOUNT_ID = 'acct123';
process.env.R2_BUCKET = 'carisca-uploads';
process.env.R2_ACCESS_KEY_ID = 'key-id';
process.env.R2_SECRET_ACCESS_KEY = 'secret';

const { createR2Driver } = await import('../../src/core/files/drivers/r2.js');

const notFound = (name = 'NoSuchKey') => Object.assign(new Error(name), {
  name, $metadata: { httpStatusCode: 404 },
});

let driver;

beforeEach(() => {
  jest.clearAllMocks();
  driver = createR2Driver();
  send.mockResolvedValue({});
});

describe('client configuration', () => {
  test('derives the R2 endpoint from the account id and pins region auto', async () => {
    await driver.put('k.png', Buffer.from('x'), {});

    expect(S3ClientMock).toHaveBeenCalledWith(expect.objectContaining({
      region: 'auto',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'key-id', secretAccessKey: 'secret' },
    }));
  });

  test('builds the client once and reuses it', async () => {
    await driver.put('a.png', Buffer.from('x'), {});
    await driver.put('b.png', Buffer.from('x'), {});

    expect(S3ClientMock).toHaveBeenCalledTimes(1);
  });

  test('does not connect until something is actually stored', () => {
    createR2Driver();
    expect(S3ClientMock).not.toHaveBeenCalled();
  });
});

describe('uploading', () => {
  test('stores under the key it was given, unchanged', async () => {
    const result = await driver.put('event_banner/2026/abc.png', Buffer.from('png'), {
      mimeType: 'image/png',
    });

    expect(result).toEqual({ key: 'event_banner/2026/abc.png' });

    const sent = send.mock.calls[0][0];
    expect(sent.input).toMatchObject({
      Bucket: 'carisca-uploads',
      Key: 'event_banner/2026/abc.png',
      ContentType: 'image/png',
    });
  });

  test('sets the content type so the browser is not left guessing', async () => {
    await driver.put('speaker_photo/2026/x.webp', Buffer.from('x'), { mimeType: 'image/webp' });

    expect(send.mock.calls[0][0].input.ContentType).toBe('image/webp');
  });
});

describe('reading', () => {
  test('streams an object', async () => {
    send.mockResolvedValue({ Body: Readable.from([Buffer.from('image-bytes')]) });

    const stream = await driver.stream('event_banner/2026/abc.png');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString()).toBe('image-bytes');
  });

  test('buffers an object', async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });

    await expect(driver.buffer('k.png')).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test('reports a missing key as missing, so callers can 404', async () => {
    send.mockRejectedValue(notFound());

    const err = await driver.stream('gone.png').catch((e) => e);

    expect(err.notFound).toBe(true);
    expect(err.name).toBe('ObjectMissingError');
  });

  test('does not disguise a real failure as a missing object', async () => {
    send.mockRejectedValue(Object.assign(new Error('InternalError'), {
      name: 'InternalError', $metadata: { httpStatusCode: 500 },
    }));

    const err = await driver.buffer('k.png').catch((e) => e);

    expect(err.notFound).toBeUndefined();
    expect(err.message).toBe('InternalError');
  });
});

describe('signed urls', () => {
  test('signs a time-limited url for one object', async () => {
    getSignedUrlMock.mockResolvedValue('https://acct123.r2.cloudflarestorage.com/x?sig=abc');

    await expect(driver.signedUrl('k.png', { expiresInSeconds: 60 }))
      .resolves.toMatch(/^https:\/\//);

    expect(getSignedUrlMock).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { expiresIn: 60 },
    );
  });
});

describe('verify', () => {
  test('passes when the bucket is reachable', async () => {
    send.mockResolvedValue({});

    await expect(driver.verify()).resolves.toEqual({
      bucket: 'carisca-uploads', account: 'acct123',
    });
  });

  test('explains a missing bucket rather than surfacing a bare 404', async () => {
    send.mockRejectedValue(notFound('NotFound'));

    await expect(driver.verify()).rejects.toThrow(/does not exist in this R2 account/);
  });

  test('explains a permission failure rather than surfacing a bare 403', async () => {
    send.mockRejectedValue(Object.assign(new Error('Forbidden'), {
      name: 'Forbidden', $metadata: { httpStatusCode: 403 },
    }));

    await expect(driver.verify()).rejects.toThrow(/read and write/i);
  });
});
