import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  network: {
    l2RpcUrl: process.env.L2_RPC_URL,
    l1RpcUrl: process.env.L1_RPC_URL || 'https://rpc.ankr.com/eth',
    networkName: process.env.NETWORK_NAME || 'localhost',
  },
  contracts: {
    networkController: process.env.NETWORK_CONTROLLER_ADDRESS,
    workerRegistration: process.env.WORKER_REGISTRATION_ADDRESS,
    rewardsDistribution: process.env.REWARDS_DISTRIBUTION_ADDRESS,
    staking: process.env.STAKING_ADDRESS,
    capedStaking: process.env.CAPED_STAKING_ADDRESS,
    sqd: process.env.SQD_TOKEN_ADDRESS,
  },
  distributor: {
    address: process.env.DISTRIBUTOR_ADDRESS,
    privateKey: process.env.DISTRIBUTOR_PRIVATE_KEY,
    skipSignatureValidation: process.env.SKIP_SIGNATURE_VALIDATION === 'true',
  },
  fordefi: {
    accessToken: process.env.FORDEFI_ACCESS_TOKEN || '',
    vaultId: process.env.FORDEFI_VAULT_ID || '',
    secretKey: process.env.FORDEFI_SECRET_KEY || '',
    txGasPrice: parseInt(process.env.FORDEFI_TX_GAS_PRICE || '100000000', 10),
  },
  options: {
    confirmations: 1,
    timeout: 30000,
  },
})); 