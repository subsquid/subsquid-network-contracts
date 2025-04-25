# Subsquid Network Contracts

<p align="center">
  <img src="https://subsquid.io/logo.png" height="200px" />
</p>

This is a monorepo that contains contracts and utils that enable [Subsquid](https://subsquid.io/) decentralised network

-----------

### 🔍 What Is a Merkle Mountain Range (MMR) 

A Merkle Mountain Range is like a “forest” of perfect Merkle trees (the “mountains”), each one packed as tightly as possible, side by side. 
Instead of rebuilding one giant Merkle tree every time we append new data:
* Append a new leaf
  * Find the rightmost “mountain” whose height matches our new leaf count (a perfect power-of-two subtree)
  * Hash the new leaf with its immediate sibling(s) to climb up that mountain, creating new parent nodes as needed

* “Bag the peaks”
  * After we’ve added all the leaves, we take the root of each perfect subtree (each “mountain peak”)
    then we hash those peaks pairwise—left to right—until we collapse them into a single, final MMR root
  * Those two steps let us grow the data set one leaf at a time (append-only) without ever touching old leaves, yet still end up with a single 32-byte root that cryptographically commits to     
     every leaf ever added

### 🛠 How This Powers DistributedRewardsDistribution

Our rewards pipeline leverages MMR to securely batch-and-release thousands of worker payouts with minimal on-chain footprint:

1. **Off-chain: Collect & Batch thousands of per-worker rewards**  
   - Pull each worker’s reward slice from ClickHouse.  
   - Group them into fixed-size batches (e.g. 200 workers per batch).  
   - For each batch, compute a “batch leaf hash”:
     ```ts
     keccak256(abi.encode(recipients[], workerRewards[], stakerRewards[]))
     ```
   - Assemble a list of `BatchInput = { batchId, recipients[], workerRewards[], stakerRewards[], leafHash }`.

2. **Off-chain: Build the MMR**  
   - **Append** each `leafHash` into our in-memory MMR structure, creating only the minimal new parent hashes.  
   - **Compute peaks** via bit-twiddling on the leaf count to isolate perfect subtrees.  
   - **Bag peaks** into one final MMR root and record each leaf’s inclusion proof (an array of sibling hashes + cross-peak bag-hashes).

3. **On-chain: Commit & Approve the MMR Root**  
- We only store a single bytes32 finalRoot and a 64-bit totalLeaves on-chain per block-range key

4. **On-chain: Distribute Each Batch**
 ```
rewardsContract.distributeBatch(
  [fromBlock, toBlock],
  kIndex,        // “mountain k-index” inside its peak
  leafIndex,     // sequential batch ID
  recipients[],  // worker IDs
  workerRewards[],
  stakerRewards[],
  merkleProof[]  // sibling-hash proof + bagged peaks
);
 ```
- The contract recomputes the batch’s leaf hash, then calls:
`MerkleMountainRange.VerifyProof(finalRoot, merkleProof, [MmrLeaf(kIndex, leafIndex, leafHash)], totalLeaves)`

On success, it marks the batch as processed, updates each worker’s accumulatedRewards, and triggers `router.staking().distribute(…)`

-------------

Subsquid uses [pnpm](https://pnpm.io/) as a package and monorepo manager.
To install `pnpm`, run `npm install -g pnpm` or consult with [pnpm installation guide](https://pnpm.io/installation).

Install all dependencies using
```bash
pnpm install
```

### Packages:
 - [Subsquid Network Contracts](./packages/contracts)
 - [Reward Simulator](./packages/rewards-calculator), process that calculates rewards based on 
