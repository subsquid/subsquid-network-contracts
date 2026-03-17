/**
 * E2E: S3 save / load round-trip test.
 *
 * Uses the real S3 credentials from .env (Cloudflare R2).
 * Skipped entirely when S3_ENABLED is not 'true' or when the S3 bucket
 * is not accessible (e.g., invalid bucket name with newer SDK versions).
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';

// Load .env from the package root
dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
});

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

jest.setTimeout(60_000);

let s3Client: S3Client;
let s3Accessible = false;
const BUCKET = process.env.S3_BUCKET || '';
const S3_ENABLED = process.env.S3_ENABLED === 'true';
const TEST_PREFIX = `e2e-test-${Date.now()}`;
const keysToCleanup: string[] = [];

function testKey(name: string): string {
  const key = `${TEST_PREFIX}/${name}.json`;
  keysToCleanup.push(key);
  return key;
}

async function putJson(key: string, data: any): Promise<void> {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    }),
  );
}

async function getJson(key: string): Promise<any | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );

    if (!response.Body) return null;

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error: any) {
    if (error instanceof NoSuchKey || error?.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

async function headExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return true;
  } catch (error: any) {
    if (
      error instanceof NoSuchKey ||
      error?.name === 'NoSuchKey' ||
      error?.name === 'NotFound' ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Verify S3 bucket is accessible. Returns true if we can connect.
 */
async function checkS3Access(client: S3Client): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3 round-trip E2E', () => {
  beforeAll(async () => {
    if (!S3_ENABLED || !BUCKET) {
      return; // tests will be skipped below
    }

    const isR2 = (process.env.S3_ENDPOINT || '').includes(
      'r2.cloudflarestorage.com',
    );

    const clientConfig: any = {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_ACCESS_KEY_SECRET!,
      },
      maxAttempts: 1,
      requestHandler: { requestTimeout: 30000 },
    };

    if (isR2) {
      clientConfig.forcePathStyle = true;
    }

    s3Client = new S3Client(clientConfig);
    s3Accessible = await checkS3Access(s3Client);

    if (!s3Accessible) {
      console.warn(
        `S3 bucket "${BUCKET}" is not accessible -- S3 E2E tests will be skipped`,
      );
    }
  });

  afterAll(async () => {
    if (!s3Accessible || !s3Client) return;

    // Clean up test keys
    for (const key of keysToCleanup) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
        );
      } catch {
        // ignore cleanup errors
      }
    }
  });

  function skipUnless(condition: boolean, reason: string) {
    if (!condition) {
      test.skip(reason, () => {});
      return false;
    }
    return true;
  }

  it('upload -> download round-trip preserves data', async () => {
    if (!S3_ENABLED || !s3Accessible) {
      console.log('SKIPPED: S3 not enabled or bucket not accessible');
      return;
    }

    const key = testKey('roundtrip');
    const payload = {
      epochInfo: { fromBlock: 1000, toBlock: 2000 },
      merkleTree: { root: '0xabcdef', totalBatches: 2 },
      workers: [
        { id: '1', reward: '1000000000000000000' },
        { id: '2', reward: '2000000000000000000' },
      ],
      timestamp: new Date().toISOString(),
    };

    await putJson(key, payload);
    const downloaded = await getJson(key);

    expect(downloaded).not.toBeNull();
    expect(downloaded.epochInfo.fromBlock).toBe(1000);
    expect(downloaded.epochInfo.toBlock).toBe(2000);
    expect(downloaded.merkleTree.root).toBe('0xabcdef');
    expect(downloaded.workers).toHaveLength(2);
    expect(downloaded.workers[0].reward).toBe('1000000000000000000');
  });

  it('download non-existent key returns null', async () => {
    if (!S3_ENABLED || !s3Accessible) {
      console.log('SKIPPED: S3 not enabled or bucket not accessible');
      return;
    }

    const key = `${TEST_PREFIX}/does-not-exist-${Date.now()}.json`;
    const result = await getJson(key);
    expect(result).toBeNull();
  });

  it('checkFileExists: true for uploaded, false for non-existent', async () => {
    if (!S3_ENABLED || !s3Accessible) {
      console.log('SKIPPED: S3 not enabled or bucket not accessible');
      return;
    }

    const key = testKey('exists-check');
    const payload = { test: true };

    // Before upload: should not exist
    const beforeExists = await headExists(key);
    expect(beforeExists).toBe(false);

    // Upload
    await putJson(key, payload);

    // After upload: should exist
    const afterExists = await headExists(key);
    expect(afterExists).toBe(true);

    // Non-existent key
    const nope = await headExists(`${TEST_PREFIX}/nope-${Date.now()}.json`);
    expect(nope).toBe(false);
  });
});
