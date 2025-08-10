import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3ServiceException,
  NoSuchBucket,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { S3Config } from '../config/s3.config';
import * as crypto from 'crypto';

export interface EpochRewardsData {
  epochInfo: {
    fromBlock: number;
    toBlock: number;
    startTime: string;
    endTime: string;
    epochDuration: number;
    timestamp: string;
    network: string;
  };
  
  merkleTree: {
    root: string;
    totalBatches: number;
    batchSize: number;
    leaves: Array<{
      batchIndex: number;
      leafHash: string;
      recipients: string[];
      workerRewards: string[];
      stakerRewards: string[];
    }>;
  };
  
  rawData: {
    totalWorkers: number;
    workers: Array<{
      workerId: string;
      peerId: string;
      workerReward: string;
      stakerReward: string;
      totalReward: string;
      stake: string;
      performance: {
        bytesServed: number;
        chunksRead: number;
        requestsProcessed: number;
        requestErrorRate: number;
        livenessCoefficient: number;
      };
    }>;
  };
  
  networkMetrics: {
    totalRequests: number;
    totalBytesServed: number;
    totalChunksRead: number;
  };
  
  rewardSummary: {
    totalWorkerRewards: string;
    totalStakerRewards: string;
    totalRewards: string;
    currency: string;
  };
  
  distribution: {
    commitTxHash?: string;
    distributionTxHashes?: string[];
    gasUsed?: string;
    blockNumber?: number;
    uploadedAt: string;
  };
  
  verification: {
    dataHash: string;
    signature?: string;
    version: string;
  };
  
  workersData?: Array<{
    workerId: bigint | string;
    workerReward: string;
    stakerReward: string;
    id?: string;
    stake?: string;
  }>;
  
  batchSize?: number;
}

export interface S3UploadResult {
  key: string;
  url: string;
  size: number;
  bucket: string;
  etag?: string;
  versionId?: string;
}

export class S3UploadError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    public readonly originalError?: any,
  ) {
    super(message);
    this.name = 'S3UploadError';
  }
}

export class S3ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3ConfigurationError';
  }
}

@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);
  private s3Client: S3Client | null = null;
  private readonly enabled: boolean;
  private readonly config: S3Config;
  private healthStatus = false;
  private lastHealthCheck: Date | null = null;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.get<S3Config>('s3')!;
    this.enabled = !!this.config?.enabled;
    
    if (this.config?.debugMode) {
      this.logger.debug('S3 Service initializing with config:', {
        enabled: this.enabled,
        endpoint: this.config?.endpoint?.substring(0, 30) + '...',
        bucket: this.config?.bucket,
        region: this.config?.region,
      });
    }
  }

  async onModuleInit() {
    this.logger.log(`🔍 S3 Service module init - enabled: ${this.enabled}`);
    if (this.enabled) {
      await this.initialize();
    } else {
      this.logger.warn('S3 service is disabled via configuration');
    }
  }

  private async initialize(): Promise<void> {
    try {
      this.logger.log('🚀 Starting S3 service initialization...');
      
      this.validateConfiguration();
      this.logger.log('✅ S3 configuration validated');
      
      this.initializeS3Client();
      this.logger.log('✅ S3 client created');
      
      const isHealthy = await this.checkHealth();
      if (!isHealthy) {
        this.logger.warn('⚠️ Initial S3 health check failed - will retry on first upload');
        this.healthStatus = false;
      } else {
        this.healthStatus = true;
        this.logger.log('✅ S3 health check passed');
      }
      
      this.logger.log('✅ S3 service initialized');
      this.logger.log(`📦 Using bucket: ${this.config.bucket}`);
      this.logger.log(`🌐 Endpoint: ${this.config.endpoint.substring(0, 50)}...`);
    } catch (error) {
      this.logger.error('❌ Failed to initialize S3 service', error);
      this.logger.error(`Error details: ${JSON.stringify(error)}`);
      
      if (!this.s3Client) {
        this.s3Client = null;
      }
      this.healthStatus = false;
      
      this.logger.error('⚠️ S3 service initialization had errors but will continue');
    }
  }

  private validateConfiguration(): void {
    const missingFields: string[] = [];
    
    if (!this.config.endpoint) {
      missingFields.push('S3_ENDPOINT');
    }
    if (!this.config.accessKeyId) {
      missingFields.push('S3_ACCESS_KEY_ID');
    }
    if (!this.config.accessKeySecret) {
      missingFields.push('S3_ACCESS_KEY_SECRET');
    }
    if (!this.config.bucket) {
      missingFields.push('S3_BUCKET');
    }
    
    if (missingFields.length > 0) {
      throw new S3ConfigurationError(
        `Missing required S3 configuration: ${missingFields.join(', ')}`
      );
    }
    
    if (!this.config.endpoint.startsWith('http://') && !this.config.endpoint.startsWith('https://')) {
      throw new S3ConfigurationError(
        'S3_ENDPOINT must start with http:// or https://'
      );
    }
  }

  private initializeS3Client(): void {
    const isCloudflareR2 = this.config.endpoint.includes('r2.cloudflarestorage.com');
    
    const clientConfig: any = {
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.accessKeySecret,
      },
      maxAttempts: 1,
      requestHandler: {
        requestTimeout: this.config.requestTimeout,
      },
    };
    
    if (isCloudflareR2) {
      clientConfig.forcePathStyle = true;
      clientConfig.signatureVersion = 'v4';
      this.logger.log('🔧 Detected Cloudflare R2, applying compatibility settings');
    } else if (this.config.forcePathStyle) {
      clientConfig.forcePathStyle = true;
    }
    
    this.s3Client = new S3Client(clientConfig);
  }

  async checkHealth(): Promise<boolean> {
    if (!this.s3Client) {
      this.healthStatus = false;
      return false;
    }
    
    try {
      const command = new HeadBucketCommand({ 
        Bucket: this.config.bucket 
      });
      
      await this.s3Client.send(command);
      
      this.healthStatus = true;
      this.lastHealthCheck = new Date();
      
      if (this.config.debugMode) {
        this.logger.debug(`✅ S3 health check passed for bucket: ${this.config.bucket}`);
      }
      
      return true;
    } catch (error) {
      this.healthStatus = false;
      this.lastHealthCheck = new Date();
      
      if (error instanceof NoSuchBucket) {
        this.logger.error(`❌ S3 bucket does not exist: ${this.config.bucket}`);
      } else if (error instanceof S3ServiceException) {
        this.logger.error(`❌ S3 service error: ${error.message}`);
      } else {
        this.logger.error('❌ S3 health check failed', error);
      }
      
      return false;
    }
  }

  private async uploadWithRetry(
    command: PutObjectCommand,
    metadata: { key: string; attempt?: number }
  ): Promise<any> {
    const maxAttempts = this.config.retryAttempts;
    const attempt = metadata.attempt || 1;
    
    try {
      if (this.config.debugMode && attempt > 1) {
        this.logger.debug(`🔄 S3 upload retry ${attempt}/${maxAttempts} for ${metadata.key}`);
      }
      
      const response = await this.s3Client!.send(command);
      
      if (this.config.debugMode) {
        this.logger.debug(`✅ S3 upload successful on attempt ${attempt} for ${metadata.key}`);
      }
      
      return response;
    } catch (error) {
      const isRetryable = this.isRetryableError(error);
      
      if (attempt < maxAttempts && isRetryable) {
        const delay = this.calculateRetryDelay(attempt);
        
        this.logger.warn(
          `⚠️ S3 upload attempt ${attempt} failed for ${metadata.key}, retrying in ${delay}ms...`,
          { error: error.message }
        );
        
        await this.sleep(delay);
        
        return this.uploadWithRetry(command, { 
          ...metadata, 
          attempt: attempt + 1 
        });
      }
      
      throw error;
    }
  }

  private isRetryableError(error: any): boolean {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return true;
    }
    
    if (error instanceof S3ServiceException) {
      const retryableCodes = [
        'RequestTimeout',
        'ServiceUnavailable',
        'ThrottlingException',
        'TooManyRequestsException',
        'InternalError',
        'SlowDown',
      ];
      
      return retryableCodes.includes(error.name);
    }
    
    if (error.$metadata?.httpStatusCode) {
      const status = error.$metadata.httpStatusCode;
      return status === 429 || status === 503 || status >= 500;
    }
    
    return false;
  }

  private calculateRetryDelay(attempt: number): number {
    const baseDelay = this.config.retryDelay;
    const maxDelay = this.config.maxRetryDelay || 10000;
    
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt - 1),
      maxDelay
    );
    
    const jitter = exponentialDelay * Math.random() * 0.2;
    
    return Math.floor(exponentialDelay + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async uploadEpochRewards(
    epochData: EpochRewardsData,
  ): Promise<S3UploadResult> {
    if (!this.enabled) {
      throw new S3ConfigurationError('S3 service is disabled');
    }
    
    if (!this.s3Client) {
      throw new S3ConfigurationError('S3 client not initialized');
    }
    
    const network = epochData.epochInfo.network;
    const fromBlock = epochData.epochInfo.fromBlock;
    const toBlock = epochData.epochInfo.toBlock;
    const key = `rewards/${network}/distributions/${fromBlock}-${toBlock}.json`;
    
    try {
      let targetKey = key;
      const canonicalExists = await this.checkFileExists(key);
      if (canonicalExists) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const duplicatesPrefix = `rewards/${network}/distributions/duplicates/${fromBlock}-${toBlock}-`;
        const nextIteration = await this.getNextDuplicateIteration(duplicatesPrefix);
        targetKey = `${duplicatesPrefix}${nextIteration}-${timestamp}.json`;
        this.logger.log(
          `🟡 Canonical epoch file exists, writing duplicate as: ${targetKey}`,
        );
      } else {
        this.logger.log(`📤 Uploading epoch rewards to S3: ${key}`);
      }
      
      const jsonData = JSON.stringify(epochData, null, 2);
      const buffer = Buffer.from(jsonData, 'utf8');
      
      const dataHash = crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
      
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: targetKey,
        Body: buffer,
        ContentType: 'application/json',
        Metadata: {
          'epoch-from-block': fromBlock.toString(),
          'epoch-to-block': toBlock.toString(),
          'network': network,
          'merkle-root': epochData.merkleTree.root,
          'total-batches': epochData.merkleTree.totalBatches.toString(),
          'total-workers': epochData.rawData.totalWorkers.toString(),
          'data-hash': dataHash,
          'uploaded-at': new Date().toISOString(),
          'version': '2.0',
          ...(canonicalExists ? { 'duplicate-of': key } : {}),
        },
      });
      
      const response = await this.uploadWithRetry(command, { key: targetKey });
      
      const url = this.generatePublicUrl(targetKey);
      
      this.logger.log(
        `✅ Epoch rewards uploaded successfully: ${targetKey} (${buffer.length} bytes)`
      );
      
      return {
        key: targetKey,
        url,
        size: buffer.length,
        bucket: this.config.bucket,
        etag: response.ETag,
        versionId: response.VersionId,
      };
    } catch (error) {
      const errorMessage = `Failed to upload epoch rewards to S3: ${error.message}`;
      this.logger.error(errorMessage, error);
      
      throw new S3UploadError(errorMessage, key, error);
    }
  }

  async uploadJson(
    data: any, 
    key: string,
    metadata?: Record<string, string>
  ): Promise<S3UploadResult> {
    if (!this.enabled) {
      throw new S3ConfigurationError('S3 service is disabled');
    }
    
    if (!this.s3Client) {
      throw new S3ConfigurationError('S3 client not initialized');
    }
    
    try {
      const jsonData = JSON.stringify(data, null, 2);
      const buffer = Buffer.from(jsonData, 'utf8');
      
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/json',
        Metadata: {
          'uploaded-at': new Date().toISOString(),
          ...metadata,
        },
      });
      
      const response = await this.uploadWithRetry(command, { key });
      
      const url = this.generatePublicUrl(key);
      
      this.logger.log(
        `✅ JSON data uploaded to S3: ${key} (${buffer.length} bytes)`
      );
      
      return {
        key,
        url,
        size: buffer.length,
        bucket: this.config.bucket,
        etag: response.ETag,
        versionId: response.VersionId,
      };
    } catch (error) {
      const errorMessage = `Failed to upload JSON to S3: ${error.message}`;
      this.logger.error(errorMessage, error);
      
      throw new S3UploadError(errorMessage, key, error);
    }
  }

  async downloadJson(key: string): Promise<any> {
    if (!this.enabled) {
      throw new S3ConfigurationError('S3 service is disabled');
    }
    
    if (!this.s3Client) {
      throw new S3ConfigurationError('S3 client not initialized');
    }
    
    try {
      this.logger.log(`📥 Downloading data from S3: ${key}`);
      
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });
      
      const response = await this.s3Client.send(command);
      
      if (!response.Body) {
        throw new Error('No data in S3 response');
      }
      
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      const jsonData = buffer.toString('utf8');
      const data = JSON.parse(jsonData);
      
      this.logger.log(`✅ Downloaded data from S3: ${key} (${buffer.length} bytes)`);
      
      return data;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.logger.warn(`File not found in S3: ${key}`);
        return null;
      }
      
      const errorMessage = `Failed to download from S3: ${error.message}`;
      this.logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  }

  async getEpochRewardsJson(network: string, fromBlock: number, toBlock: number): Promise<EpochRewardsData | null> {
    const key = this.generateS3Key(network, fromBlock, toBlock);
    return this.downloadJson(key);
  }

  async checkFileExists(key: string): Promise<boolean> {
    if (!this.enabled || !this.s3Client) {
      return false;
    }
    
    try {
      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });
      
      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return false;
      }
      if (error instanceof S3ServiceException) {
        const status = (error as any)?.$metadata?.httpStatusCode;
        const name = (error as any)?.name;
        const code = (error as any)?.Code || (error as any)?.code;
        if (status === 404 || name === 'NotFound' || name === 'NoSuchKey' || code === 'NoSuchKey') {
          return false;
        }
        if (status === 400 && (name === 'UnknownError' || !name)) {
          return false;
        }
      }
      
      const status = (error as any)?.$metadata?.httpStatusCode;
      const name = (error as any)?.name;
      this.logger.warn(`error checking file existence in s3: ${name || 'unknown'} (http ${status ?? 'n/a'})`);
      return false;
    }
  }

  async getFileMetadata(key: string): Promise<Record<string, string> | null> {
    if (!this.enabled || !this.s3Client) {
      return null;
    }
    
    try {
      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });
      
      const response = await this.s3Client.send(command);
      return response.Metadata || {};
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.logger.warn(`File not found in S3: ${key}`);
      } else {
        this.logger.error(`Failed to get file metadata from S3: ${key}`, error);
      }
      return null;
    }
  }

  async listFiles(prefix: string, maxKeys = 100): Promise<string[]> {
    if (!this.enabled || !this.s3Client) {
      return [];
    }
    
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix,
        MaxKeys: maxKeys,
      });
      
      const response = await this.s3Client.send(command);
      
      if (!response.Contents) {
        return [];
      }
      
      return response.Contents.map(obj => obj.Key!).filter(key => key != null);
    } catch (error) {
      this.logger.error(`Failed to list files in S3 with prefix: ${prefix}`, error);
      return [];
    }
  }

  generateS3Key(network: string, fromBlock: number, toBlock: number): string {
    return `rewards/${network}/distributions/${fromBlock}-${toBlock}.json`;
  }

  private async getNextDuplicateIteration(prefix: string): Promise<number> {
    try {
      const files = await this.listFiles(prefix, 1000);
      if (!files || files.length === 0) {
        return 2;
      }
      let maxIter = 1;
      for (const key of files) {
        const rest = key.substring(prefix.length);
        const firstDash = rest.indexOf('-');
        if (firstDash > 0) {
          const iterStr = rest.substring(0, firstDash);
          const iter = parseInt(iterStr, 10);
          if (!Number.isNaN(iter)) {
            maxIter = Math.max(maxIter, iter);
          }
        }
      }
      return maxIter + 1;
    } catch (e) {
      
      this.logger.warn(`could not list duplicates for prefix ${prefix}, defaulting to iteration 2`);
      return 2;
    }
  }

  private generatePublicUrl(key: string): string {
    if (this.config.endpoint.includes('r2.cloudflarestorage.com')) {
      const match = this.config.endpoint.match(/https:\/\/([^.]+)\.r2\.cloudflarestorage\.com/);
      if (match) {
        return `https://pub-${match[1]}.r2.dev/${key}`;
      }
    }
    
    return `${this.config.endpoint}/${this.config.bucket}/${key}`;
  }

  isEnabled(): boolean {
    const result = this.enabled && this.s3Client !== null;
    if (this.enabled && !result) {
      this.logger.warn('⚠️ S3 is enabled in config but client is not initialized');
      this.logger.warn('⚠️ Check the initialization logs above for errors');
    }
    return result;
  }

  isHealthy(): boolean {
    return this.healthStatus;
  }

  getLastHealthCheck(): Date | null {
    return this.lastHealthCheck;
  }

  getConfig() {
    return {
      enabled: this.enabled,
      endpoint: this.config?.endpoint,
      bucket: this.config?.bucket,
      region: this.config?.region,
      healthy: this.healthStatus,
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const testKey = `test/connection-test-${Date.now()}.json`;
      const testData = {
        timestamp: new Date().toISOString(),
        test: true,
      };
      
      await this.uploadJson(testData, testKey);
      
      const downloaded = await this.downloadJson(testKey);
      
      if (downloaded.timestamp !== testData.timestamp) {
        throw new Error('Downloaded data does not match uploaded data');
      }
      
      this.logger.log('✅ S3 connection test successful');
      return { success: true };
    } catch (error) {
      const errorMessage = `S3 connection test failed: ${error.message}`;
      this.logger.error(errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}