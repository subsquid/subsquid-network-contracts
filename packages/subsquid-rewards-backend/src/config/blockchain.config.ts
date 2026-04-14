import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  network: {
    l2RpcUrl: process.env.L2_RPC_URL,
    l1RpcUrl: process.env.L1_RPC_URL,
    networkName: process.env.NETWORK_NAME || 'localhost',
  },
  contracts: {
    networkController: process.env.NETWORK_CONTROLLER_ADDRESS,
    workerRegistration: process.env.WORKER_REGISTRATION_ADDRESS,
    rewardsDistribution: process.env.REWARDS_DISTRIBUTION_ADDRESS,
    staking: process.env.STAKING_ADDRESS,
    capedStaking: process.env.CAPED_STAKING_ADDRESS,
    sqd: process.env.SQD_TOKEN_ADDRESS,
    rewardCalculation: process.env.REWARD_CALCULATION_ADDRESS,
  },
  distributor: {
    address: process.env.DISTRIBUTOR_ADDRESS,
    privateKey: process.env.DISTRIBUTOR_PRIVATE_KEY,
  },
  options: {
    confirmations: 1,
    timeout: 30000,
  },
  epochConfirmationBlocks: parseInt(
    process.env.EPOCH_CONFIRMATION_BLOCKS || '150',
    10,
  ),
  rewardEpochLength: parseInt(
    process.env.REWARD_EPOCH_LENGTH_BLOCKS || '7000',
    10,
  ),
  maxEpochsPerCommit: parseInt(process.env.MAX_EPOCHS_PER_COMMIT || '1', 10),
}));
