import { Module } from '@nestjs/common';
import { MetricsLoggerService } from './metrics-logger.service';

@Module({
  providers: [MetricsLoggerService],
  exports: [MetricsLoggerService],
})
export class CommonModule {} 