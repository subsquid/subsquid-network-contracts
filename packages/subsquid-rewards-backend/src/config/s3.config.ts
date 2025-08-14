import { registerAs } from '@nestjs/config';

function parseBoolean(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value == null) return defaultValue;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

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
  maxRetryDelay: number;
  forcePathStyle: boolean;
  debugMode: boolean;
  pathPrefix?: string;
}

export default registerAs('s3', (): S3Config => {
  const config: S3Config = {
    enabled: parseBoolean(process.env.S3_ENABLED, false),
    endpoint: process.env.S3_ENDPOINT || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.S3_ACCESS_KEY_SECRET || '',
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET || 'metadata',
    cloudflareStorageSecret: process.env.CLOUDFLARE_STORAGE_SECRET || '',
    retryAttempts: parseInt(process.env.S3_RETRY_ATTEMPTS || '3', 10),
    retryDelay: parseInt(process.env.S3_RETRY_DELAY || '1000', 10),
    maxRetryDelay: parseInt(process.env.S3_MAX_RETRY_DELAY || '10000', 10),
    requestTimeout: parseInt(process.env.S3_REQUEST_TIMEOUT || '30000', 10),
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, true),
    debugMode: parseBoolean(process.env.S3_DEBUG, false),
    pathPrefix: process.env.S3_PATH_PREFIX || process.env.NETWORK_NAME || 'unknown',
  };

  if (process.env.NODE_ENV !== 'production' || config.debugMode) {
    console.log('[S3Config] Configuration loaded:', {
      enabled: config.enabled,
      endpoint: config.endpoint
        ? `${config.endpoint.substring(0, 30)}...`
        : 'NOT SET',
      bucket: config.bucket,
      region: config.region,
      pathPrefix: config.pathPrefix,
      hasAccessKey: !!config.accessKeyId,
      hasSecret: !!config.accessKeySecret,
      retryAttempts: config.retryAttempts,
      debugMode: config.debugMode,
    });
  }

  return config;
});
