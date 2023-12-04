import { useEffect, useState } from "react";
import { Abi } from "viem";
import { distributorContractConfig } from "../config/contracts";
import { Address, UseContractEventConfig, usePublicClient } from "wagmi";
import { AbiEvent } from "abitype/src/abi";

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

      let approvals = await publicClient.getLogs({
        ...distributorContractConfig,
        event: getEventByName(distributorContractConfig.abi, "Approved"),
        fromBlock: 0n,
      });

      const distributeTxs = new Set(
        distributions.map(({ transactionHash }) => transactionHash),
      );
      const _rewards: any = approvals
        .filter(({ transactionHash }) => distributeTxs.has(transactionHash))
        .map((approval) => ({
          ...approval.args,
          fromBlock: (
            distributions.find(
              ({ transactionHash }) =>
                transactionHash === approval.transactionHash,
            )?.args as any
          )?.fromBlock,
          toBlock: (
            distributions.find(
              ({ transactionHash }) =>
                transactionHash === approval.transactionHash,
            )?.args as any
          )?.toBlock,
        }))
        .reverse();

      setRewards(_rewards);
    })();
  }, []);

  return rewards;
};
