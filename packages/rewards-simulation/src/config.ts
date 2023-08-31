import workerRegistrationAbi from '../../contracts/artifacts/WorkerRegistration.sol/WorkerRegistration'
import tSQDAbi from '../../contracts/artifacts/tSQD.sol/tSQD'
import rewardCalculationAbi from '../../contracts/artifacts/RewardCalculation.sol/RewardCalculation'
import rewardsDistributionAbi from '../../contracts/artifacts/RewardsDistribution.sol/RewardsDistribution'
import {Address, getContract, GetContractReturnType} from "viem";
import {publicClient, walletClient} from "./client";
import tsqdDeployment from "../../contracts/deployments/arbitrum-goerli/tSQD.json";
import workerRegistrationDeployment from "../../contracts/deployments/arbitrum-goerli/WorkerRegistrationFacade.json";
import rewardCalculationDeployment from "../../contracts/deployments/arbitrum-goerli/RewardCalculation.json";
import rewardsDistributionDeployment from "../../contracts/deployments/arbitrum-goerli/RewardsDistribution.json";

type ContractName = keyof typeof abis

export const addresses = {
  workerRegistration: workerRegistrationDeployment.address,
  tSQD: tsqdDeployment.address,
  rewardCalculation: rewardCalculationDeployment.address,
  rewardsDistribution: rewardsDistributionDeployment.address,
} as { [key in ContractName]: Address }

export const abis = {
  workerRegistration: workerRegistrationAbi,
  tSQD: tSQDAbi,
  rewardCalculation: rewardCalculationAbi,
  rewardsDistribution: rewardsDistributionAbi,
} as const

function contract<T extends ContractName>(name: T): GetContractReturnType<typeof abis[T]['abi'], typeof publicClient, typeof walletClient> {
  return getContract({
    address: addresses[name],
    abi: abis[name].abi as any,
    publicClient,
    walletClient,
  }) as any
}

export const contracts = {
  workerRegistration: contract('workerRegistration'),
  tSQD: contract('tSQD'),
  rewardCalculation: contract('rewardCalculation'),
  rewardsDistribution: contract('rewardsDistribution'),
}
