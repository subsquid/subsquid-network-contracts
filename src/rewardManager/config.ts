import workerRegistrationAbi from '../../artifacts/WorkerRegistration.sol/WorkerRegistration'
import tSQDAbi from '../../artifacts/tSQD.sol/tSQD'
import rewardCalculationAbi from '../../artifacts/RewardCalculation.sol/RewardCalculation'
import {Address, getContract, GetContractReturnType} from "viem";
import {publicClient} from "./client";
import tsqdDeployment from "../../deployments/localhost/tSQD.json";
import workerRegistrationDeployment from "../../deployments/localhost/WorkerRegistration.json";
import rewardCalculationDeployment from "../../deployments/localhost/RewardCalculation.json";

type ContractName = keyof typeof abis

export const addresses = {
    workerRegistration: workerRegistrationDeployment.address,
    tSQD: tsqdDeployment.address,
    rewardCalculation: rewardCalculationDeployment.address,
} as {[key in ContractName]: Address}

export const abis = {
  workerRegistration: workerRegistrationAbi,
  tSQD: tSQDAbi,
  rewardCalculation: rewardCalculationAbi,
} as const

function contract<T extends ContractName>(name: T): GetContractReturnType<typeof abis[T]['abi'], typeof publicClient> {
  return getContract({
    address: addresses[name],
    abi: abis[name].abi as any,
    publicClient,
  }) as any
}

export const contracts = {
  workerRegistration: contract('workerRegistration'),
  tSQD: contract('tSQD'),
  rewardCalculation: contract('rewardCalculation'),
}
