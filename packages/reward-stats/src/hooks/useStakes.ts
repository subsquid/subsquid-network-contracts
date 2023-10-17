import { Rewards } from "./useRewards";
import { allWorkerIds } from "../utils/allWorkerIds";
import { useContractReads } from "wagmi";
import { stakingContractConfig } from "../config/contracts";

export type Stakes = {
  [key: number]: bigint;
};
export const useStakes = (rewards: Rewards[]): Stakes => {
  const allWorkers = allWorkerIds(rewards);

  const stakes = useContractReads({
    contracts: allWorkerIds(rewards).map((id) => ({
      ...stakingContractConfig,
      functionName: "activeStake",
      args: [[id]],
    })),
  });

  return Object.fromEntries(
    allWorkers.map((id, index) => [
      id,
      BigInt(stakes.data?.[index]?.result as any),
    ]),
  );
};
