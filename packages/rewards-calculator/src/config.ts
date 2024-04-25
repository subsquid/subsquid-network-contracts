import workerRegistrationAbi from "../../contracts/artifacts/WorkerRegistration.sol/WorkerRegistration";
import SQDAbi from "../../contracts/artifacts/SQD.sol/SQD";
import rewardCalculationAbi from "../../contracts/artifacts/RewardCalculation.sol/RewardCalculation";
import rewardsDistributionAbi from "../../contracts/artifacts/DistributedRewardDistribution.sol/DistributedRewardsDistribution";
import stakingAbi from "../../contracts/artifacts/Staking.sol/Staking";
import capAbi from "../../contracts/artifacts/SoftCap.sol/SoftCap";
import networkControllerAbi from "../../contracts/artifacts/NetworkController.sol/NetworkController";
import deployments from "../../contracts/deployments/421614.json" assert { type: "json" };
import { Address, createPublicClient, getContract, http } from "viem";
import { arbitrumSepolia, sepolia } from "viem/chains";

function env<T>(
  name: string,
  defaultValue?: T,
): string | T extends undefined ? string : T {
  if (defaultValue === undefined && process.env[name] === undefined) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return process.env[name] ?? (defaultValue as any);
}

export const config = {
  targetCapacityGB: BigInt(env("TARGET_CAPACITY_GB", 30_000n)),
  workerOfflineThreshold: Number(env("WORKER_OFFLINE_THRESHOLD_SECONDS", 65)),
  dTrafficAlpha: Number(env("D_TRAFFIC_ALPHA", 0.1)),
  requestPrice: BigInt(env("REQUEST_PRICE", 1n)),
  tenureEpochCount: Number(env("TENURE_EPOCH_COUNT", 10)),
  workTimeout: Number(env("WORK_TIMEOUT_SECONDS", 300)) * 1000,
  epochConfirmationTime: Number(env("EPOCH_CONFIRMATION_SECONDS", 900)) * 1000,
  maxEpochsPerCommit: Number(env("MAX_EPOCHS_PER_COMMIT", 10)),
  clickhouse: {
    username: env("CLICKHOUSE_USERNAME", "sqd_read"),
    password: env("CLICKHOUSE_PASSWORD"),
    url: env("CLICKHOUSE_URL", "https://clickhouse.subsquid.io/"),
    logsTableName: env("CLICKHOUSE_LOGS_TABLE", "testnet.worker_query_logs"),
    pingsTableName: env("CLICKHOUSE_PINGS_TABLE", "testnet.worker_pings"),
  },
  fordefi: {
    accessToken: env("FORDEFI_ACCESS_TOKEN"),
    vaultId: env("FORDEFI_VAULT_ID"),
    secretPath: env("FORDEFI_SECRET_KEY", "./private.pem"),
  },
  network: {
    gasLimit: BigInt(env("GAS_LIMIT", 10_000_000n)),
    l2RpcUrl: env(
      "L2_RPC_URL",
      "https://arbitrum-sepolia.infura.io/v3/39b9cd000b9c4637b58d5a5214676196",
    ),
  },
};

export type ContractName = keyof typeof abis;

export const addresses = {
  workerRegistration: deployments.WorkerRegistration,
  SQD: deployments.tSQDArbitrum,
  rewardCalculation: deployments.RewardCalculation,
  rewardsDistribution: deployments.DistributedRewardsDistribution,
  staking: deployments.Staking,
  capedStaking: deployments.SoftCap,
  networkController: deployments.NetworkController,
} as { [key in ContractName]: Address };

export const abis = {
  workerRegistration: workerRegistrationAbi,
  SQD: SQDAbi,
  rewardCalculation: rewardCalculationAbi,
  rewardsDistribution: rewardsDistributionAbi,
  staking: stakingAbi,
  capedStaking: capAbi,
  networkController: networkControllerAbi,
};

export const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(config.network.l2RpcUrl),
});
export const l1Client = createPublicClient({
  chain: sepolia,
  transport: http(),
});

export function contract<T extends ContractName>(name: T) {
  return getContract({
    address: addresses[name],
    abi: abis[name].abi,
    publicClient,
  });
}

export const contracts = {
  workerRegistration: contract("workerRegistration"),
  SQD: contract("SQD"),
  rewardCalculation: contract("rewardCalculation"),
  rewardsDistribution: contract("rewardsDistribution"),
  staking: contract("staking"),
  capedStaking: contract("capedStaking"),
  networkController: contract("networkController"),
};
