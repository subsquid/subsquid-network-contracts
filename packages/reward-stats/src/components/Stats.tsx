import { Rewards } from "../hooks/useRewards";
import { RewardsChart } from "./RewardsChart";
import { formatEther } from "viem";
import { ReactNode, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { goerli } from "wagmi/chains";
import { epochStats } from "@subsquid-network/rewards-simulation/src/reward";

const toNumber = (eth: bigint) => Number(formatEther(eth));

const formatToken = (amount: number) => `${amount} tSQD`;

const StatsRow = ({ title, value }: { title: string; value: ReactNode }) => (
  <div className="flex space-x-1">
    <p className="font-bold">{title}</p>
    <p>{value}</p>
  </div>
);

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString("en-us", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
};

const EpochTimestamp = ({
  fromBlock,
  toBlock,
}: {
  fromBlock: bigint;
  toBlock: bigint;
}) => {
  const publicClient = usePublicClient({
    chainId: goerli.id,
  });
  const [fromTimestamp, setFromTimestamp] = useState(0);
  const [toTimestamp, setToTimestamp] = useState(0);

  useEffect(() => {
    publicClient
      .getBlock({
        blockNumber: fromBlock,
      })
      .then((block) => setFromTimestamp(Number(block.timestamp) * 1000));
    publicClient
      .getBlock({
        blockNumber: toBlock,
      })
      .then((block) => setToTimestamp(Number(block.timestamp) * 1000));
  }, []);

  // useEffect(() => {
  //   if (fromTimestamp && toTimestamp) {
  //     epochStats(new Date(fromTimestamp), new Date(toTimestamp)).then(
  //       console.log,
  //     );
  //   }
  // }, [fromTimestamp, toTimestamp]);

  return (
    <div className="text-center ">
      <h2 className="font-bold uppercase">
        Epoch blocks {Number(fromBlock)} - {Number(toBlock)}
      </h2>
      <p>
        {`${formatDate(fromTimestamp)}`} - {`${formatDate(toTimestamp)}`}
      </p>
    </div>
  );
};

export const Stats = ({ reward }: { reward: Rewards | undefined }) => {
  if (!reward) return null;

  const chartData = reward.recipients
    .map((recipient, idx) => ({
      workerId: Number(recipient),
      workerReward: toNumber(reward.workerRewards[idx]),
      stakerReward: toNumber(reward.stakerRewards[idx]),
    }))
    .sort((a, b) => b.workerReward - a.workerReward);

  const totalWorkers = chartData.length;
  const totalWorkersRewarded = chartData.filter(
    (data) => data.workerReward > 0,
  ).length;
  const totalWorkerReward = chartData.reduce(
    (acc, data) => acc + data.workerReward,
    0,
  );
  const totalStakerReward = chartData.reduce(
    (acc, data) => acc + data.stakerReward,
    0,
  );

  return (
    <>
      <EpochTimestamp fromBlock={reward.fromBlock} toBlock={reward.toBlock} />
      <StatsRow
        title="Workers rewardsd"
        value={`${totalWorkersRewarded}/${totalWorkers}`}
      />
      <StatsRow
        title="Total worker reward"
        value={formatToken(totalWorkerReward)}
      />
      <StatsRow
        title="Total staker reward"
        value={formatToken(totalStakerReward)}
      />
      <RewardsChart rewards={chartData} />;
    </>
  );
};
