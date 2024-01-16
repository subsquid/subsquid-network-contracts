import { Address } from "wagmi";
import Deployments from "../../../contracts/deployments/421614.json";
import rewardsDistributionAbi from "../../../contracts/artifacts/DistributedRewardDistribution.sol/DistributedRewardsDistribution";
import workerRegistrationAbi from "../../../contracts/artifacts/WorkerRegistration.sol/WorkerRegistration";
import stakingAbi from "../../../contracts/artifacts/Staking.sol/Staking";

export const distributorContractConfig = {
  address: Deployments.DistributedRewardsDistribution as Address,
  abi: rewardsDistributionAbi.abi,
};

export const workerRegistrationContractConfig = {
  address: Deployments.WorkerRegistration as Address,
  abi: workerRegistrationAbi.abi,
};

export const stakingContractConfig = {
  address: Deployments.Staking as Address,
  abi: stakingAbi.abi,
};
