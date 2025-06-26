import { registerAs } from '@nestjs/config';

export const rewardsConfig = registerAs('rewards', () => ({
  targetCapacityGB: BigInt(process.env.TARGET_CAPACITY_GB || '30000'),
  workerOfflineThreshold: parseInt(process.env.WORKER_OFFLINE_THRESHOLD_SECONDS || '65', 10),
  tenureEpochCount: parseInt(process.env.TENURE_EPOCH_COUNT || '10', 10),
  
  dTrafficAlpha: parseFloat(process.env.D_TRAFFIC_ALPHA || '0.1'),
  requestPrice: parseInt(process.env.REQUEST_PRICE || '1', 10),
  
  workTimeout: parseInt(process.env.WORK_TIMEOUT_SECONDS || '300', 10) * 1000,
  skipSignatureValidation: process.env.SKIP_SIGNATURE_VALIDATION === 'true',
  
  // APR calculation method: 
  // - 'contracts': Use contract-based APR calculation
  // - 'clickhouse': Use latest APR from rewards_stats table (base_apr / 10000) 
  // - 'dynamic': Use dynamic APR based on network utilization and stake factors
  aprCalculationMethod: process.env.APR_CALCULATION_METHOD || 'contracts',
  
  totalBatches: parseInt(process.env.TOTAL_BATCHES || '4', 10),
  maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '100', 10),
  maxGasPerBatch: parseInt(process.env.MAX_GAS_PER_BATCH || '10000000', 10),
  maxBatchesPerCommit: parseInt(process.env.MAX_BATCHES_PER_COMMIT || '256', 10),
  
  appPort: parseInt(process.env.APP_PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  epochIntervalHours: parseInt(process.env.EPOCH_INTERVAL_HOURS || '1', 10),
})); 