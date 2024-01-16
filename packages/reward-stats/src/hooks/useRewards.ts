import { useEffect, useState } from "react";
import { Abi } from "viem";
import { distributorContractConfig } from "../config/contracts";
import { Address, UseContractEventConfig, usePublicClient } from "wagmi";
import { AbiEvent } from "abitype/src/abi";
import { bigSum } from "@subsquid-network/rewards-calculator/src/utils";

function getEventByName<TAbi extends Abi, TEventName extends string>(
  abi: TAbi,
  eventName: UseContractEventConfig<TAbi, TEventName>["eventName"],
): AbiEvent {
  return abi.find(
    (event) => event.type === "event" && event.name === eventName,
  ) as AbiEvent;
}

export interface Rewards {
  fromBlock: bigint;
  toBlock: bigint;
  who: Address;
  recipients: bigint[];
  workerRewards: bigint[];
  stakerRewards: bigint[];
  totalReward: bigint;
}

export const useRewards = () => {
  const [rewards, setRewards] = useState<Rewards[]>([]);
  const publicClient = usePublicClient();

  useEffect(() => {
    (async () => {
      const distributions = await publicClient.getLogs({
        ...distributorContractConfig,
        event: getEventByName(distributorContractConfig.abi, "Distributed"),
        fromBlock: 0n,
      });
      const _rewards = distributions
        .map(({ args }: any) => ({
          ...args,
          totalReward: bigSum(args.workerRewards) + bigSum(args.stakerRewards),
        }))
        .reverse() as any;

      setRewards(_rewards);
    })();
  }, []);

  return rewards;
};
