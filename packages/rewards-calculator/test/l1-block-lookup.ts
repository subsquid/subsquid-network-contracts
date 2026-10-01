import { beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  id: 421614,
  head: 0n,
  l1BlockOf: (_l2Block: bigint): bigint => 0n,
}));

vi.mock('../src/config', () => ({
  config: { logScanMaxRange: 2000, clickhouse: {}, fordefi: {}, network: {} },
  addresses: {},
  contracts: {},
  l1Client: {},
  publicClient: {
    getChainId: async () => chain.id,
    getBlock: async ({
      blockNumber = chain.head,
    }: {
      blockNumber?: bigint;
    } = {}) => ({
      number: blockNumber,
      l1BlockNumber: `0x${chain.l1BlockOf(blockNumber).toString(16)}`,
    }),
  },
}));

// Fresh module per test: chain.ts remembers the last resolved block pair.
async function loadChain() {
  vi.resetModules();
  return import('../src/chain');
}

describe('getFirstBlockForL1Block', () => {
  // L1 blocks reported by L2 blocks 0..9; L1 102 and 105 are never reported.
  const L1_BY_L2 = [100n, 100n, 101n, 101n, 101n, 103n, 104n, 104n, 106n, 106n];

  beforeEach(() => {
    chain.id = 421614;
    chain.head = BigInt(L1_BY_L2.length - 1);
    chain.l1BlockOf = (l2Block) => L1_BY_L2[Number(l2Block)];
  });

  it('returns the first L2 block that reports the L1 block', async () => {
    const { getFirstBlockForL1Block } = await loadChain();

    expect(await getFirstBlockForL1Block(100)).toBe(0n);
    expect(await getFirstBlockForL1Block(101)).toBe(2n);
    expect(await getFirstBlockForL1Block(104)).toBe(6n);
  });

  it('moves to the next reported L1 block when the target was skipped', async () => {
    const { getFirstBlockForL1Block } = await loadChain();

    expect(await getFirstBlockForL1Block(102)).toBe(5n);
    expect(await getFirstBlockForL1Block(105)).toBe(8n);
  });

  it('throws when no L2 block has reached the L1 block yet', async () => {
    const { getFirstBlockForL1Block } = await loadChain();

    await expect(getFirstBlockForL1Block(107)).rejects.toThrow(
      'Unable to find l2 block for l1 block 107',
    );
  });

  it('stays correct across calls in any order', async () => {
    const { getFirstBlockForL1Block } = await loadChain();

    expect(await getFirstBlockForL1Block(103)).toBe(5n);
    expect(await getFirstBlockForL1Block(106)).toBe(8n);
    expect(await getFirstBlockForL1Block(101)).toBe(2n);
    expect(await getFirstBlockForL1Block(102)).toBe(5n);
    expect(await getFirstBlockForL1Block(102)).toBe(5n);
  });

  it('resolves the L1 block that follows a skipped one', async () => {
    const { getFirstBlockForL1Block } = await loadChain();

    // Remembers 102 -> 5, although block 5 reports L1 103.
    expect(await getFirstBlockForL1Block(102)).toBe(5n);
    expect(await getFirstBlockForL1Block(103)).toBe(5n);
  });

  it('rejects an L1 block before the Nitro genesis on Arbitrum One', async () => {
    chain.id = 42161;
    const { getFirstBlockForL1Block } = await loadChain();

    await expect(getFirstBlockForL1Block(15447157n)).rejects.toThrow(
      'before the Nitro genesis block',
    );
  });

  it('searches Arbitrum One from its first Nitro L2 block', async () => {
    chain.id = 42161;
    chain.head = 22207826n;
    chain.l1BlockOf = (l2Block) => {
      if (l2Block < 22207817n) {
        throw new Error(`pre-Nitro L2 block ${l2Block} requested`);
      }
      return 15447158n + (l2Block - 22207817n);
    };
    const { getFirstBlockForL1Block } = await loadChain();

    expect(await getFirstBlockForL1Block(15447160n)).toBe(22207819n);
  });

  it('resolves an L1 block that Arbitrum One skipped', async () => {
    // Mainnet: L2 510611453 reports L1 26096420, L2 510611454 reports L1 26096422.
    chain.id = 42161;
    chain.head = 510611460n;
    chain.l1BlockOf = (l2Block) =>
      l2Block <= 510611453n ? 26096420n : 26096422n;
    const { getFirstBlockForL1Block } = await loadChain();

    expect(await getFirstBlockForL1Block(26096421n)).toBe(510611454n);
  });
});
