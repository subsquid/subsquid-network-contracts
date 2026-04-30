import { Module } from '@nestjs/common';
import { MetricsLoggerService } from './metrics-logger.service';
import { CommitmentKeyService } from './commitment-key.service';

@Module({
  providers: [MetricsLoggerService, CommitmentKeyService],
  exports: [MetricsLoggerService, CommitmentKeyService],
})
export class CommonModule {}
