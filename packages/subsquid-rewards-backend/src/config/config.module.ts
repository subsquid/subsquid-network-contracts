import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { privateKeyToAddress } from 'viem/accounts';
import { isAddress, getAddress } from 'viem';
import databaseConfig from './database.config';
import blockchainConfig from './blockchain.config';
import { rewardsConfig } from './rewards.config';
import s3Config from './s3.config';

// validate critical environment variables
const validateConfig = (config: Record<string, unknown>) => {
  const requiredVars = [
    'CLICKHOUSE_URL',
    'CLICKHOUSE_USERNAME',
    'CLICKHOUSE_PASSWORD',
    'L2_RPC_URL',
    'L1_RPC_URL',
    'NETWORK_NAME',
    'DISTRIBUTOR_ADDRESS',
    'DISTRIBUTOR_PRIVATE_KEY',
    'NETWORK_CONTROLLER_ADDRESS',
    'WORKER_REGISTRATION_ADDRESS',
    'REWARDS_DISTRIBUTION_ADDRESS',
    'STAKING_ADDRESS',
    'CAPED_STAKING_ADDRESS',
    'REWARD_CALCULATION_ADDRESS',
    'SQD_TOKEN_ADDRESS',
    'ADMIN_API_KEY',
  ];

  const missing = requiredVars.filter((varName) => !config[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file and ensure all critical values are set.',
    );
  }

  const privateKey = String(config.DISTRIBUTOR_PRIVATE_KEY);
  const declaredAddress = String(config.DISTRIBUTOR_ADDRESS);

  // validate private key format
  if (!privateKey.startsWith('0x')) {
    throw new Error('DISTRIBUTOR_PRIVATE_KEY must start with "0x"');
  }
  if (privateKey.length !== 66) {
    throw new Error(
      `DISTRIBUTOR_PRIVATE_KEY must be 32 bytes (66 hex chars incl. 0x); got ${privateKey.length}`,
    );
  }

  if (!isAddress(declaredAddress)) {
    throw new Error(
      `DISTRIBUTOR_ADDRESS is not a valid Ethereum address: ${declaredAddress}`,
    );
  }

  // RWD-M-007 — cross-check that the declared DISTRIBUTOR_ADDRESS actually
  // corresponds to DISTRIBUTOR_PRIVATE_KEY. Without this guard, a misconfig
  // manifests silently as "canCommit(bot) is always false" and the backend
  // enters an indefinite no-op loop that looks like a RPC lag. Fail loudly
  // at boot instead.
  //
  let derivedAddress: string;
  try {
    derivedAddress = privateKeyToAddress(privateKey as `0x${string}`);
  } catch (error) {
    throw new Error(
      `DISTRIBUTOR_PRIVATE_KEY is not a valid secp256k1 key: ${(error as Error).message}`,
    );
  }

  if (getAddress(derivedAddress) !== getAddress(declaredAddress)) {
    throw new Error(
      `DISTRIBUTOR_ADDRESS does not match the address derived from DISTRIBUTOR_PRIVATE_KEY. ` +
        `Declared: ${getAddress(declaredAddress)}, derived: ${getAddress(derivedAddress)}. ` +
        `Fix the env so the two agree; continuing would leave canCommit(bot) ` +
        `permanently false and the bot would never progress.`,
    );
  }

  return config;
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, blockchainConfig, rewardsConfig, s3Config],
      validate: validateConfig,
    }),
  ],
})
export class AppConfigModule {}
