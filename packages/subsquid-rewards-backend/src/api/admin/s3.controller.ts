import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { S3Service } from '../../s3/s3.service';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

@ApiTags('S3 Management')
@Controller('admin/s3')
export class S3Controller {
  constructor(private readonly s3Service: S3Service) {}

  @Get('status')
  @ApiOperation({ summary: 'Get S3 service status' })
  @ApiResponse({ status: 200, description: 'S3 service status' })
  async getStatus() {
    const config = this.s3Service.getConfig();
    const isEnabled = this.s3Service.isEnabled();
    const isHealthy = this.s3Service.isHealthy();
    const lastHealthCheck = this.s3Service.getLastHealthCheck();

    return {
      enabled: isEnabled,
      healthy: isHealthy,
      lastHealthCheck: lastHealthCheck?.toISOString() || null,
      config: {
        endpoint: config.endpoint
          ? config.endpoint.substring(0, 50) + '...'
          : 'NOT SET',
        bucket: config.bucket || 'NOT SET',
        region: config.region || 'NOT SET',
      },
    };
  }

  @Post('health-check')
  @ApiOperation({ summary: 'Perform S3 health check' })
  @ApiResponse({ status: 200, description: 'Health check result' })
  async performHealthCheck() {
    try {
      const isHealthy = await this.s3Service.checkHealth();

      return {
        success: true,
        healthy: isHealthy,
        timestamp: new Date().toISOString(),
        message: isHealthy
          ? 'S3 service is healthy'
          : 'S3 service health check failed',
      };
    } catch (error) {
      return {
        success: false,
        healthy: false,
        timestamp: new Date().toISOString(),
        error: error.message,
      };
    }
  }

  @Post('test-connection')
  @ApiOperation({ summary: 'Test S3 connection with upload/download' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async testConnection() {
    try {
      const result = await this.s3Service.testConnection();

      return {
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        `Connection test failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('list')
  @ApiOperation({ summary: 'List files in S3 with optional prefix' })
  @ApiQuery({
    name: 'prefix',
    required: false,
    description: 'File prefix to filter',
  })
  @ApiQuery({
    name: 'maxKeys',
    required: false,
    description: 'Maximum number of files to return',
  })
  @ApiResponse({ status: 200, description: 'List of files' })
  async listFiles(
    @Query('prefix') prefix = '',
    @Query('maxKeys') maxKeys?: string,
  ) {
    try {
      const limit = maxKeys ? parseInt(maxKeys, 10) : 100;
      const files = await this.s3Service.listFiles(prefix, limit);

      return {
        success: true,
        prefix,
        count: files.length,
        files,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to list files: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('file-metadata')
  @ApiOperation({ summary: 'Get file metadata' })
  @ApiResponse({ status: 200, description: 'File metadata' })
  async getFileMetadata(@Body() body: { key: string }) {
    const { key } = body;
    try {
      const exists = await this.s3Service.checkFileExists(key);

      if (!exists) {
        return {
          success: false,
          exists: false,
          key,
          message: 'File not found',
        };
      }

      const metadata = await this.s3Service.getFileMetadata(key);

      return {
        success: true,
        exists: true,
        key,
        metadata,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to get file metadata: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('download')
  @ApiOperation({ summary: 'Download JSON file from S3' })
  @ApiResponse({ status: 200, description: 'File content' })
  async downloadFile(@Body() body: { key: string }) {
    const { key } = body;
    try {
      const data = await this.s3Service.downloadJson(key);

      if (!data) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }

      return {
        success: true,
        key,
        data,
      };
    } catch (error) {
      if (error.status === HttpStatus.NOT_FOUND) {
        throw error;
      }

      throw new HttpException(
        `Failed to download file: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('upload-test')
  @ApiOperation({ summary: 'Upload test data to S3' })
  @ApiResponse({ status: 200, description: 'Upload result' })
  async uploadTest(@Body() body: { data?: any; key?: string }) {
    try {
      const testData = body.data || {
        test: true,
        timestamp: new Date().toISOString(),
        message: 'Test upload from admin API',
      };

      const key = body.key || `test/admin-upload-${Date.now()}.json`;

      const result = await this.s3Service.uploadJson(testData, key, {
        source: 'admin-api',
        test: 'true',
      });

      return {
        success: true,
        result,
        message: 'Test data uploaded successfully',
      };
    } catch (error) {
      throw new HttpException(
        `Upload test failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('epoch/:fromBlock/:toBlock')
  @ApiOperation({ summary: 'Check if epoch data exists in S3' })
  @ApiParam({ name: 'fromBlock', description: 'Start block number' })
  @ApiParam({ name: 'toBlock', description: 'End block number' })
  @ApiQuery({ name: 'network', required: false, description: 'Network name' })
  @ApiResponse({ status: 200, description: 'Epoch data status' })
  async checkEpochData(
    @Param('fromBlock') fromBlock: string,
    @Param('toBlock') toBlock: string,
    @Query('network') network = 'arbitrum',
  ) {
    try {
      const key = this.s3Service.generateS3Key(
        network,
        parseInt(fromBlock, 10),
        parseInt(toBlock, 10),
      );

      const exists = await this.s3Service.checkFileExists(key);

      if (!exists) {
        return {
          success: true,
          exists: false,
          key,
          message: 'Epoch data not found in S3',
        };
      }

      const metadata = await this.s3Service.getFileMetadata(key);

      return {
        success: true,
        exists: true,
        key,
        metadata,
        message: 'Epoch data found in S3',
      };
    } catch (error) {
      throw new HttpException(
        `Failed to check epoch data: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('recent-uploads')
  @ApiOperation({ summary: 'Get recent uploads to S3' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of files',
  })
  @ApiResponse({ status: 200, description: 'Recent uploads' })
  async getRecentUploads(@Query('limit') limit = '20') {
    try {
      const maxKeys = parseInt(limit, 10);
      const files = await this.s3Service.listFiles('rewards/', maxKeys);

      // Parse file names to extract epoch info
      const uploads = files.map((file) => {
        const match = file.match(
          /rewards\/(\w+)\/distributions\/(\d+)-(\d+)\.json/,
        );
        if (match) {
          return {
            key: file,
            network: match[1],
            fromBlock: parseInt(match[2], 10),
            toBlock: parseInt(match[3], 10),
          };
        }
        return { key: file };
      });

      return {
        success: true,
        count: uploads.length,
        uploads,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to get recent uploads: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('cleanup-test-files')
  @ApiOperation({ summary: 'Clean up test files from S3' })
  @ApiResponse({ status: 200, description: 'Cleanup result' })
  async cleanupTestFiles() {
    try {
      const testFiles = await this.s3Service.listFiles('test/', 100);

      if (testFiles.length === 0) {
        return {
          success: true,
          message: 'No test files found',
          cleaned: 0,
        };
      }

      // Note: Actual deletion would require adding a delete method to S3Service
      // For now, just return the list of files that would be deleted

      return {
        success: true,
        message: `Found ${testFiles.length} test files (deletion not implemented)`,
        files: testFiles,
        cleaned: 0,
      };
    } catch (error) {
      throw new HttpException(
        `Cleanup failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
