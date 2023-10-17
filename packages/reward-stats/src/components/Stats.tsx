import { Rewards } from "../hooks/useRewards";
import { RewardsChart } from "./RewardsChart";
import { formatEther } from "viem";
import { ReactNode, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { goerli } from "wagmi/chains";
import { useWorkers } from "../hooks/useWorkers";
import { useBond } from "../hooks/useBond";
import { Stakes, useStakes } from "../hooks/useStakes";

const toNumber = (eth: bigint) => Number(formatEther(eth));

const formatToken = (amount: bigint) => `${toNumber(amount)} tSQD`;

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString("en-us", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
};

const bnSum = (bns: bigint[]) => bns.reduce((sum, bn) => sum + bn, 0n);

const StatsRow = ({
  title,
  value,
  className,
}: {
  title: string;
  value: ReactNode;
  className?: string;
}) => (
  <div className={`${className} flex space-x-1`}>
    <p className="font-bold">{title}</p>
    <p>{value}</p>
  </div>
);

const CommonStats = ({
  fromBlock,
  toBlock,
  stakes,
  bond,
  reward,
}: {
  reward: Rewards;
  fromBlock: bigint;
  toBlock: bigint;
  stakes: Stakes;
  bond: bigint;
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
  }, [fromBlock, toBlock]);

  const totalWorkers = reward.workerRewards.length;
  const totalWorkersRewarded = reward.workerRewards.filter(
    (reward) => reward > 0,
  ).length;

  const totalBond = bond * BigInt(Object.keys(stakes).length);
  const totalStake = bnSum(Object.values(stakes));
  const tvl = totalBond + totalStake;
  const workerReward = bnSum(reward.workerRewards);
  const stakerReward = bnSum(reward.stakerRewards);
  const totalReward = workerReward + stakerReward;
  const timeDiff = toTimestamp - fromTimestamp;
  console.log(timeDiff > 0 && (1000 * 60 * 60 * 24 * 365) / timeDiff);
  console.log(
    timeDiff > 0 &&
      formatToken(
        (totalReward * BigInt(1000 * 60 * 60 * 24 * 365)) / BigInt(timeDiff),
      ),
  );
  const apy = !tvl
    ? 0
    : Number((100n * totalReward * BigInt(1000 * 60 * 60 * 24 * 365)) / tvl) /
      timeDiff;

  return (
    <div className="text-center ">
      <h2 className="font-bold uppercase">
        Epoch blocks {Number(fromBlock)} - {Number(toBlock)}
      </h2>
      <p>
        {`${formatDate(fromTimestamp)}`} - {`${formatDate(toTimestamp)}`}
      </p>
      <div className="grid grid-cols-2">
        <StatsRow
          className="col-span-2"
          title="Workers rewardsd"
          value={`${totalWorkersRewarded}/${totalWorkers}`}
        />
        <StatsRow
          title="Total worker reward"
          value={formatToken(workerReward)}
        />
        <StatsRow
          title="Total staker reward"
          value={formatToken(stakerReward)}
        />
        <StatsRow title="Total reward" value={formatToken(totalReward)} />
        <StatsRow
          title="TVL"
          value={`${formatToken(tvl)} (${formatToken(
            totalBond,
          )} + ${formatToken(totalStake)})`}
        />
        <StatsRow title="APY" value={`${(apy / 100).toFixed(2)}%`} />
      </div>
    </div>
  );
};

export const Stats = ({
  rewards,
  selectedReward,
}: {
  rewards: Rewards[];
  selectedReward: number;
}) => {
  const workers = useWorkers(rewards);
  const stakes = useStakes(rewards);
  const bond = useBond();

  const reward = rewards[selectedReward];
  if (!reward) return null;

  const chartData = reward.recipients
    .map((recipient, idx) => ({
      workerId: Number(recipient),
      workerReward: toNumber(reward.workerRewards[idx]),
      stakerReward: toNumber(reward.stakerRewards[idx]),
      stakedAmount: toNumber(stakes[Number(recipient)] ?? 0n),
    }))
    .sort((a, b) => b.workerReward - a.workerReward);

  return (
    <>
      <CommonStats
        reward={reward}
        fromBlock={reward.fromBlock}
        toBlock={reward.toBlock}
        stakes={stakes}
        bond={bond}
      />
      <RewardsChart rewards={chartData} workers={workers} />
    </>
  );
};
