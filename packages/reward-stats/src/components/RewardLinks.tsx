import { Rewards } from "../hooks/useRewards";

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
        className={`w-full cursor-pointer content-center p-2 text-center hover:bg-blue-400 ${
          selected === idx && "bg-blue-200"
        }`}
        onClick={() => onClick(idx)}
      >
        {Number(reward.fromBlock)} - {Number(reward.toBlock)}
      </div>
    ))}
  </>
);
