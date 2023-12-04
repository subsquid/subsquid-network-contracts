import { Rewards } from "../hooks/useRewards";

export const allWorkerIds = (rewards: Rewards[]) => {
  const maxWorkerId = rewards.reduce(
    (max, { recipients }) =>
      recipients.reduce((_max, id) => (id > _max ? id : _max), max),
    0n,
  );

  return [...Array(Number(maxWorkerId) + 1).keys()].slice(1);
};
