import { Address, erc20ABI } from "wagmi";
import Deployments from "../../../contracts/deployments/421613.json";
import rewardsDistributionAbi from "../../../contracts/artifacts/DistributedRewardDistribution.sol/DistributedRewardsDistribution";

export const distributorContractConfig = {
  address: Deployments.DistributedRewardsDistribution as Address,
  abi: rewardsDistributionAbi.abi,
};

export const usdcContractConfig = {
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  abi: erc20ABI,
} as const;
