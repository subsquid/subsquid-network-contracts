import { Rewards } from "./useRewards";
import { Address, useContractReads } from "wagmi";
import { workerRegistrationContractConfig } from "../config/contracts";
import { toBase58 } from "@subsquid-network/rewards-simulation/src/utils";

export interface Worker {
  peerId: string;
  creator: Address;
}

export interface Workers {
  [id: number]: Worker;
}

export const useWorkers = (rewards: Rewards[]): Workers | undefined => {
  const maxWorkerId = rewards.reduce(
    (max, { recipients }) =>
      recipients.reduce((_max, id) => (id > _max ? id : _max), max),
    0n,
  );

  const workerIds = useContractReads({
    contracts: [...Array(Number(maxWorkerId)).keys()].map((id) => ({
      ...workerRegistrationContractConfig,
      functionName: "getWorkerByIndex",
      args: [id + 1],
    })),
  });

  const workersData = workerIds.data?.map(({ result }) =>
    result
      ? ({
          ...result,
          peerId: toBase58((result as any).peerId),
        } as Worker)
      : undefined,
  );

  return Object.fromEntries(
    workersData?.map((worker, idx) => [idx + 1, worker]) ?? [],
  ) as any;
};
