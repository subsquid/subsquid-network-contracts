import { useReadContracts } from "wagmi";
import {
  distributorContractConfig,
  networkControllerContractConfig,
  rewardCalcContractConfig,
  stakingContractConfig,
} from "../config/contracts";

export function useMulticall() {
  const { data, ...rest } = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        ...distributorContractConfig,
        functionName: "lastBlockRewarded",
      },
      {
        ...distributorContractConfig,
        functionName: "roundRobinBlocks",
      },
      {
        ...distributorContractConfig,
        functionName: "windowSize",
      },
      {
        ...distributorContractConfig,
        functionName: "requiredApproves",
      },
      {
        ...networkControllerContractConfig,
        functionName: "nextEpoch",
      },
      {
        ...networkControllerContractConfig,
        functionName: "epochLength",
      },
      {
        ...networkControllerContractConfig,
        functionName: "bondAmount",
      },
      {
        ...networkControllerContractConfig,
        functionName: "storagePerWorkerInGb",
      },
      {
        ...networkControllerContractConfig,
        functionName: "targetCapacityGb",
      },
      {
        ...networkControllerContractConfig,
        functionName: "yearlyRewardCapCoefficient",
      },
      {
        ...stakingContractConfig,
        functionName: "maxDelegations",
      },
      {
        ...rewardCalcContractConfig,
        functionName: "currentApy",
      },
      {
        ...rewardCalcContractConfig,
        functionName: "apyCap",
      },
      {
        ...rewardCalcContractConfig,
        functionName: "effectiveTVL",
      },
    ],
  });

  if (!data) {
    return {
      distributor: {},
      networkController: {},
      staking: {},
      rewardCalc: {},
    };
  }

  const [
    lastBlockRewarded,
    roundRobinBlocks,
    windowSize,
    requiredApproves,
    nextEpoch,
    epochLength,
    bondAmount,
    storagePerWorkerInGb,
    targetCapacityGb,
    yearlyRewardCapCoefficient,
    maxDelegations,
    currentApy,
    apyCap,
    effectiveTVL,
  ] = data;

  return {
    distributor: {
      lastBlockRewarded,
      roundRobinBlocks,
      windowSize,
      requiredApproves,
    },
    networkController: {
      nextEpoch,
      epochLength,
      bondAmount,
      storagePerWorkerInGb,
      targetCapacityGb,
      yearlyRewardCapCoefficient,
    },
    staking: {
      maxDelegations,
    },
    rewardCalc: {
      currentApy,
      apyCap,
      effectiveTVL,
    },
  };
}
