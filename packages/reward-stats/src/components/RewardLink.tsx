import { Rewards } from "../hooks/useRewards";

interface RewardLinkProps {
  rewards: Rewards[];
  onClick(idx: number): void;
}

export const RewardLink = ({ rewards, onClick }: RewardLinkProps) => (
  <>
    {rewards.map((reward, idx) => (
      <div
        key={reward.fromBlock.toString()}
        className="w-full hover:bg-blue-400 content-center text-center p-2 cursor-pointer"
        onClick={() => onClick(idx)}
      >
        {Number(reward.fromBlock)} - {Number(reward.toBlock)}
      </div>
    ))}
  </>
);
