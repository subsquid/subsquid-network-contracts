import { registerAs } from '@nestjs/config';

export const rewardsConfig = registerAs('rewards', () => ({
  targetCapacityGB: BigInt(process.env.TARGET_CAPACITY_GB || '30000'),
  workerOfflineThreshold: parseInt(
    process.env.WORKER_OFFLINE_THRESHOLD_SECONDS || '65',
    10,
  ),
  tenureEpochCount: parseInt(process.env.TENURE_EPOCH_COUNT || '10', 10),

  dTrafficAlpha: parseFloat(process.env.D_TRAFFIC_ALPHA || '0.1'),
  requestPrice: parseInt(process.env.REQUEST_PRICE || '1', 10),

  workTimeout: parseInt(process.env.WORK_TIMEOUT_SECONDS || '300', 10) * 1000,
  // We intentionally run the backend in "skip validation" mode for now.
  // Opting back into full libp2p signature verification requires restoring
  // the exact v1 protobuf + peer-id verification path.
  skipSignatureValidation: process.env.SKIP_SIGNATURE_VALIDATION !== 'false',

  // APR calculation method:
  // - 'contracts': Use contract-based APR calculation
  // - 'clickhouse': Use latest APR from rewards_stats table (base_apr / 10000)
  // - 'dynamic': Use dynamic APR based on network utilization and stake factors
  aprCalculationMethod: process.env.APR_CALCULATION_METHOD || 'contracts',

  batchNumber: process.env.BATCH_NUMBER
    ? parseInt(process.env.BATCH_NUMBER, 10)
    : undefined,
  totalBatches: parseInt(process.env.TOTAL_BATCHES || '4', 10),
  commitmentBatchSize: parseInt(
    process.env.COMMITMENT_BATCH_SIZE ||
      process.env.DISTRIBUTION_BATCH_SIZE ||
      process.env.MAX_BATCH_SIZE ||
      '75',
    10,
  ),
  maxGasPerBatch: parseInt(process.env.MAX_GAS_PER_BATCH || '10000000', 10),
  maxBatchesPerCommit: parseInt(
    process.env.MAX_BATCHES_PER_COMMIT || '256',
    10,
  ),

  appPort: parseInt(process.env.PORT || process.env.APP_PORT || '3001', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  epochIntervalHours: parseInt(process.env.EPOCH_INTERVAL_HOURS || '1', 10),

  // block-based distribution scheduling
  distributionBlockInterval: parseInt(
    process.env.DISTRIBUTION_BLOCK_INTERVAL || '520',
    10,
  ), // default 520 blocks
  distributionStartingBlock: parseInt(
    process.env.DISTRIBUTION_STARTING_BLOCK || '0',
    10,
  ),
  enableAutoDistribution: process.env.ENABLE_AUTO_DISTRIBUTION === 'true',

  roundRobinWindow: parseInt(process.env.ROUND_ROBIN_WINDOW || '120', 10),
  commitSafetyBuffer: parseInt(process.env.COMMIT_SAFETY_BUFFER || '3', 10),

  botIndex: parseInt(process.env.BOT_INDEX || '0', 10),
  botId: process.env.BOT_ID || 'bot-0',
}));
