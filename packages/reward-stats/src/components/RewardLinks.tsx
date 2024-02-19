import { Rewards } from "../hooks/useRewards";
import { formatSqd, bigIntToDecimal } from "@subsquid-network/rewards-calculator/src/utils";

interface RewardLinkProps {
  rewards: Rewards[];
  onClick(idx: number): void;
  selected: number;
}

export const RewardLinks = ({
  rewards,
  onClick,
  selected,
}: RewardLinkProps) => (
  <>
    {rewards.map((reward, idx) => (
      <div
        key={reward.fromBlock.toString()}
        className={`w-full cursor-pointer content-center p-2 text-center text-xs hover:bg-blue-400 ${
          selected === idx && "bg-blue-200"
        }`}
        onClick={() => onClick(idx)}
      >
        {Number(reward.fromBlock)} - {Number(reward.toBlock)} (Rewarded:{" "}
        {formatSqd(bigIntToDecimal(reward.totalReward))})
      </div>
    ))}
  </>
);
