import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

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
  
  // Data integrity
  verification: {
    dataHash: string;
    signature?: string;
    version: string;
  };
}

export interface S3UploadResult {
  key: string;
  url: string;
  size: number;
  bucket: string;
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private s3Client: S3Client | null = null;
  private readonly enabled: boolean;
  private readonly config: any;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.get('s3');
    this.enabled = this.config?.enabled || true;
    
    if (this.enabled) {
      this.initializeS3Client();
    } else {
      this.logger.warn('S3 service is disabled');
    }
  }

  private initializeS3Client(): void {
    try {
      this.s3Client = new S3Client({
        endpoint: this.config.endpoint,
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.accessKeySecret,
        },
        requestHandler: {
          requestTimeout: this.config.requestTimeout,
        },
      });

      this.logger.log(`S3 client initialized with endpoint: ${this.config.endpoint}`);
      this.logger.log(`Using bucket: ${this.config.bucket}`);
    } catch (error) {
      this.logger.error('Failed to initialize S3 client', error);
      this.s3Client = null;
    }
  }

  async uploadEpochRewards(
    epochData: EpochRewardsData,
  ): Promise<S3UploadResult | null> {
    if (!this.enabled || !this.s3Client) {
      this.logger.warn('S3 upload skipped - service not available');
      return null;
    }

    try {
      const network = epochData.epochInfo.network;
      const fromBlock = epochData.epochInfo.fromBlock;
      const toBlock = epochData.epochInfo.toBlock;
      
      const key = `rewards/${network}/distributions/${fromBlock}-${toBlock}.json`;
      
      this.logger.log(
        `📤 Uploading epoch rewards to S3: ${key}`,
      );

      const jsonData = JSON.stringify(epochData, null, 2);
      const buffer = Buffer.from(jsonData, 'utf8');

      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/json',
        Metadata: {
          'epoch-from-block': fromBlock.toString(),
          'epoch-to-block': toBlock.toString(),
          'network': network,
          'merkle-root': epochData.merkleTree.root,
          'total-batches': epochData.merkleTree.totalBatches.toString(),
          'total-workers': epochData.rawData.totalWorkers.toString(),
          'uploaded-at': new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      const url = `${this.config.endpoint}/${this.config.bucket}/${key}`;

      this.logger.log(
        `✅ Epoch rewards uploaded to S3: ${key} (${buffer.length} bytes)`,
      );

      return {
        key,
        url,
        size: buffer.length,
        bucket: this.config.bucket,
      };
    } catch (error) {
      this.logger.error('Failed to upload epoch rewards to S3', error);
      return null;
    }
  }

  async uploadJson(
    data: any, 
    key: string,
    metadata?: Record<string, string>
  ): Promise<S3UploadResult | null> {
    if (!this.enabled || !this.s3Client) {
      this.logger.warn('S3 upload skipped - service not available');
      return null;
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

      await this.s3Client.send(command);

      const url = `${this.config.endpoint}/${this.config.bucket}/${key}`;

      this.logger.log(
        `✅ JSON data uploaded to S3: ${key} (${buffer.length} bytes)`,
      );

      return {
        key,
        url,
        size: buffer.length,
        bucket: this.config.bucket,
      };
    } catch (error) {
      this.logger.error(`Failed to upload JSON data to S3: ${key}`, error);
      return null;
    }
  }

  async downloadJson(key: string): Promise<any | null> {
    if (!this.enabled || !this.s3Client) {
      this.logger.warn('S3 download skipped - service not available');
      return null;
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
      this.logger.error(`Failed to download data from S3: ${key}`, error);
      return null;
    }
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
      this.logger.error(`Failed to get file metadata from S3: ${key}`, error);
      return null;
    }
  }

  generateS3Key(network: string, fromBlock: number, toBlock: number): string {
    return `rewards/local/distributions/${fromBlock}-${toBlock}.json`;
  }

  isEnabled(): boolean {
    return this.enabled && this.s3Client !== null;
  }

  getConfig() {
    return {
      enabled: this.enabled,
      endpoint: this.config?.endpoint,
      bucket: this.config?.bucket,
      region: this.config?.region,
    };
  }
}