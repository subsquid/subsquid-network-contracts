import { registerAs } from '@nestjs/config';

export interface S3Config {
  enabled: boolean;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  cloudflareStorageSecret?: string;
  retryAttempts: number;
  retryDelay: number;
  requestTimeout: number;
}

export default registerAs('s3', (): S3Config => ({
  enabled: process.env.S3_ENABLED === 'true',
  endpoint: process.env.S3_ENDPOINT || '',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.S3_ACCESS_KEY_SECRET || '',
  region: process.env.S3_REGION || 'auto',
  bucket: process.env.S3_BUCKET || 'metadata',
  cloudflareStorageSecret: process.env.CLOUDFLARE_STORAGE_SECRET || '',
  retryAttempts: parseInt(process.env.S3_RETRY_ATTEMPTS || '3', 10),
  retryDelay: parseInt(process.env.S3_RETRY_DELAY || '1000', 10),
  requestTimeout: parseInt(process.env.S3_REQUEST_TIMEOUT || '30000', 10),
}));