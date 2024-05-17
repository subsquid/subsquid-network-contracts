import Deployments from "../../../contracts/deployments/42161.json";
import rewardsDistributionAbi from "../../../contracts/artifacts/DistributedRewardDistribution.sol/DistributedRewardsDistribution";
import stakingAbi from "../../../contracts/artifacts/Staking.sol/Staking";
import networkControllerAbi from "../../../contracts/artifacts/NetworkController.sol/NetworkController";
import gatewayRegistryAbi from "../../../contracts/artifacts/GatewayRegistry.sol/GatewayRegistry";
import rewardCalculationAbi from "../../../contracts/artifacts/RewardCalculation.sol/RewardCalculation";
import type { Address } from "viem";
import { arbitrum } from "wagmi/chains";

export const distributorContractConfig = {
  address: Deployments.DistributedRewardsDistribution as Address,
  abi: rewardsDistributionAbi.abi,
  chainId: arbitrum.id,
};

export const networkControllerContractConfig = {
  address: Deployments.NetworkController as Address,
  abi: networkControllerAbi.abi,
  chainId: arbitrum.id,
};

export const gatewayRegistryConfig = {
  address: Deployments.GatewayRegistry as Address,
  abi: gatewayRegistryAbi.abi,
  chainId: arbitrum.id,
};

export const stakingContractConfig = {
  address: Deployments.Staking as Address,
  abi: stakingAbi.abi,
  chainId: arbitrum.id,
};

export const rewardCalcContractConfig = {
  address: Deployments.RewardCalculation as Address,
  abi: rewardCalculationAbi.abi,
  chainId: arbitrum.id,
};
