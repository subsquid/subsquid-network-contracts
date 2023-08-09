import workerRegistrationAbi from '../../artifacts/WorkerRegistration.sol/WorkerRegistration'
import tSQDAbi from '../../artifacts/tSQD.sol/tSQD'
// import rewardCalculationAbi from '../../artifacts/RewardCalculation.sol/RewardCalculation'
// import rewardsDistributionAbi from '../../artifacts/RewardsDistribution.sol/RewardsDistribution'
import {Address, getContract, GetContractReturnType} from "viem";
import {publicClient, walletClient} from "./client";
import tsqdDeployment from "../../deployments/arbitrum-goerli/tSQD.json";
import workerRegistrationDeployment from "../../deployments/arbitrum-goerli/WorkerRegistration.json";
// import rewardCalculationDeployment from "../../deployments/localhost/RewardCalculation.json";
// import rewardsDistributionDeployment from "../../deployments/localhost/rewardsDistribution.json";

type ContractName = keyof typeof abis

export const addresses = {
  workerRegistration: workerRegistrationDeployment.address,
  tSQD: tsqdDeployment.address,
  // rewardCalculation: rewardCalculationDeployment.address,
  // rewardsDistribution: rewardsDistributionDeployment.address,
} as { [key in ContractName]: Address }

export const abis = {
  workerRegistration: workerRegistrationAbi,
  tSQD: tSQDAbi,
  // rewardCalculation: rewardCalculationAbi,
  // rewardsDistribution: rewardsDistributionAbi,
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
  // rewardCalculation: contract('rewardCalculation'),
  // rewardsDistribution: contract('rewardsDistribution'),
}
