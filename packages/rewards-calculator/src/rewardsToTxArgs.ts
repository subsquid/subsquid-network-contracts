import type { Rewards } from "./reward";

/**
 * Build the on-chain commit/approve arguments from the computed rewards.
 *
 * The on-chain commitment is `keccak256` over the ABI-encoded
 * `(recipients, workerRewards, stakerRewards)` arrays, so their ORDER is part of
 * the hash. Every distributor must produce byte-identical calldata for a commit
 * to collect the required approvals and distribute.
 *
 * `Object.keys` order follows ClickHouse's row order, which is NOT stable across
 * processes or even repeated queries: parallel `GROUP BY` has no guaranteed
 * output order. If bots derive different orderings they compute different
 * commitment hashes, approvals never match, and distribution stalls (see the
 * June 2026 incident). Sorting by peerId makes the ordering deterministic and
 * identical for every bot, independent of ClickHouse physical layout / threads.
 */
export function rewardsToTxArgs(rewards: Rewards) {
  const workerPeerIds = Object.keys(rewards ?? {}).sort();
  const workerIds = workerPeerIds.map((id) => rewards[id].id);
  const rewardAmounts = workerPeerIds.map((id) => rewards[id].workerReward);
  const stakedAmounts = workerPeerIds.map((id) => rewards[id].stakerReward);
  const computationUnitsUsed = workerPeerIds.map(
    (id) => rewards[id].computationUnitsUsed ?? 0n,
  );
  return { workerIds, rewardAmounts, stakedAmounts, computationUnitsUsed };
}
