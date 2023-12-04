import workerRegistrationAbi from "../../contracts/artifacts/WorkerRegistration.sol/WorkerRegistration.js";
import tSQDAbi from "../../contracts/artifacts/tSQD.sol/tSQD.js";
import rewardCalculationAbi from "../../contracts/artifacts/RewardCalculation.sol/RewardCalculation.js";
import rewardsDistributionAbi from "../../contracts/artifacts/DistributedRewardDistribution.sol/DistributedRewardsDistribution.js";
import stakingAbi from "../../contracts/artifacts/Staking.sol/Staking.js";
import { Address, getContract, WalletClient } from "viem";
import { publicClient, walletClient } from "./client.js";
import tsqdDeployment from "../../contracts/deployments/arbitrum-goerli/tSQD.json" assert { type: "json" };
import deployments from "../../contracts/deployments/421613.json" assert { type: "json" };

type ContractName = keyof typeof abis;

export const addresses = {
  workerRegistration: deployments.WorkerRegistration,
  tSQD: tsqdDeployment.address,
  rewardCalculation: deployments.RewardCalculation,
  rewardsDistribution: deployments.DistributedRewardsDistribution,
  staking: deployments.Staking,
} as { [key in ContractName]: Address };

export const abis = {
  workerRegistration: workerRegistrationAbi,
  tSQD: tSQDAbi,
  rewardCalculation: rewardCalculationAbi,
  rewardsDistribution: rewardsDistributionAbi,
  staking: stakingAbi,
} as const;

export function contract<T extends ContractName>(
  name: T,
  _walletClient: WalletClient = walletClient,
) {
  return getContract({
    address: addresses[name],
    abi: abis[name].abi,
    publicClient,
    walletClient: _walletClient,
  });
}

export const contracts = {
  workerRegistration: contract("workerRegistration"),
  tSQD: contract("tSQD"),
  rewardCalculation: contract("rewardCalculation"),
  rewardsDistribution: contract("rewardsDistribution"),
  staking: contract("staking"),
};
