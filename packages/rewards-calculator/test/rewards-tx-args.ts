import { expect } from "chai";
import { rewardsToTxArgs } from "../src/rewardsToTxArgs";
import type { Rewards } from "../src/reward";

function reward(id: bigint, worker: bigint, staker: bigint) {
  return {
    id,
    workerReward: worker,
    stakerReward: staker,
    computationUnitsUsed: Number(id),
  };
}

// Same rewards, but the keys are inserted in two different orders to emulate
// ClickHouse returning rows in a non-deterministic order between bots/runs.
function buildInScrambledOrders(): [Rewards, Rewards] {
  const entries: Array<[string, ReturnType<typeof reward>]> = [
    ["12D3KooWcZZZ", reward(3n, 300n, 30n)],
    ["12D3KooWaAAA", reward(1n, 100n, 10n)],
    ["12D3KooWbMMM", reward(2n, 200n, 20n)],
    ["12D3KooWdNNN", reward(4n, 400n, 40n)],
  ];
  const a: Rewards = {};
  for (const [k, v] of entries) a[k] = v;
  const b: Rewards = {};
  for (const [k, v] of [...entries].reverse()) b[k] = v;
  return [a, b];
}

describe("rewardsToTxArgs", () => {
  it("orders recipients by peerId regardless of insertion order", () => {
    const [a] = buildInScrambledOrders();
    const { workerIds, rewardAmounts, stakedAmounts } = rewardsToTxArgs(a);
    // sorted peerIds: aAAA(1), bMMM(2), cZZZ(3), dNNN(4)
    expect(workerIds).to.deep.equal([1n, 2n, 3n, 4n]);
    expect(rewardAmounts).to.deep.equal([100n, 200n, 300n, 400n]);
    expect(stakedAmounts).to.deep.equal([10n, 20n, 30n, 40n]);
  });

  it("is deterministic: different insertion orders yield identical args", () => {
    const [a, b] = buildInScrambledOrders();
    const argsA = rewardsToTxArgs(a);
    const argsB = rewardsToTxArgs(b);
    // This is the invariant the on-chain commitment hash depends on. If it ever
    // breaks, distributors compute different hashes and distribution stalls.
    expect(argsA).to.deep.equal(argsB);
  });

  it("handles empty rewards", () => {
    const { workerIds, rewardAmounts, stakedAmounts } = rewardsToTxArgs(
      {} as Rewards,
    );
    expect(workerIds).to.deep.equal([]);
    expect(rewardAmounts).to.deep.equal([]);
    expect(stakedAmounts).to.deep.equal([]);
  });
});
