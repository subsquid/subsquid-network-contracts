import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './database.config';
import blockchainConfig from './blockchain.config';
import { rewardsConfig } from './rewards.config';

// validate critical environment variables
const validateConfig = (config: Record<string, unknown>) => {
  const requiredVars = [
    'CLICKHOUSE_HOST',
    'CLICKHOUSE_USERNAME', 
    'CLICKHOUSE_PASSWORD',
    'L2_RPC_URL',
    'DISTRIBUTOR_ADDRESS',
    'DISTRIBUTOR_PRIVATE_KEY',
    'NETWORK_CONTROLLER_ADDRESS',
    'WORKER_REGISTRATION_ADDRESS',
    'REWARDS_DISTRIBUTION_ADDRESS',
    'STAKING_ADDRESS',
    'SQD_TOKEN_ADDRESS',
  ];

  const missing = requiredVars.filter(varName => !config[varName]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file and ensure all critical values are set.'
    );
  }

  // validate private key format
  if (config.DISTRIBUTOR_PRIVATE_KEY && !String(config.DISTRIBUTOR_PRIVATE_KEY).startsWith('0x')) {
    throw new Error('DISTRIBUTOR_PRIVATE_KEY must start with "0x"');
  }

  return config;
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, blockchainConfig, rewardsConfig],
      validate: validateConfig,
    }),
  ],
})
export class AppConfigModule {} 