import { Module } from '@nestjs/common';
import { ClickHouseModule } from './clickhouse.module';

@Module({
  imports: [ClickHouseModule],
  exports: [ClickHouseModule],
})
export class DatabaseModule {} 