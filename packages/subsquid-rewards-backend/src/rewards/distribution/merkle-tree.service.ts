import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { Context } from '../../common';
import { TaskContext } from '../../common/task-context';

export interface MerkleLeaf {
  recipients: bigint[];
  workerRewards: bigint[];
  stakerRewards: bigint[];
  leafHash: string;
}

export interface MerkleTreeResult {
  root: string;
  leaves: MerkleLeaf[];
  proofs: string[][];
  totalBatches: number;
}

@Injectable()
export class MerkleTreeService {
  async generateMerkleTree(
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    batchSize: number = 50,
  ): Promise<MerkleTreeResult> {
    let ctx: any = null;
    try {
      ctx = new TaskContext('merkle-tree:generate');
      ctx?.logger?.debug(
        `Generating Merkle tree for ${workers.length} workers with batch size ${batchSize}`,
      );
    } catch {
    }

    // CRITICAL: Sort workers deterministically by workerId to ensure consistent merkle tree
    const sortedWorkers = [...workers].sort((a, b) => {
      if (a.workerId < b.workerId) return -1;
      if (a.workerId > b.workerId) return 1;
      return 0;
    });

    try {
      ctx?.logger?.debug(
        `Sorted ${sortedWorkers.length} workers deterministically by workerId`,
      );
    } catch {
      // ignore logging for now
    }

    const batches: MerkleLeaf[] = [];
    const leafHashes: string[] = [];
    
    for (let i = 0; i < sortedWorkers.length; i += batchSize) {
      const batch = sortedWorkers.slice(i, i + batchSize);

      const leafHash = keccak256(
        encodeAbiParameters(
          parseAbiParameters('uint256[], uint256[], uint256[]'),
          [
            batch.map((w) => w.workerId),
            batch.map((w) => w.workerReward),
            batch.map((w) => w.stakerReward),
          ],
        ),
      );

      batches.push({
        recipients: batch.map((w) => w.workerId),
        workerRewards: batch.map((w) => w.workerReward),
        stakerRewards: batch.map((w) => w.stakerReward),
        leafHash,
      });
      
      leafHashes.push(leafHash);

      try {
        ctx?.logger?.debug(
          `Batch ${batches.length - 1}: ${batch.length} workers, hash: ${leafHash}`,
        );
      } catch {
   // ignore logging for now
      }
    }

    try {
      ctx?.logger?.debug(
        `Created ${batches.length} batches from ${sortedWorkers.length} workers`,
      );
    } catch {
      // ignore logging for now
    }

    // build Merkle tree
    const { root, proofs } = this.buildMerkleTree(leafHashes);

    try {
      ctx?.logger?.info(
        `✅ Merkle tree generated: root=${root}, ${batches.length} leaves`,
      );
    } catch {
      // ignore logging for now
    }

    return {
      root,
      leaves: batches,
      proofs,
      totalBatches: batches.length,
    };
  }

  // build Merkle tree from leaf hashes
  private buildMerkleTree(leaves: string[]): {
    root: string;
    proofs: string[][];
  } {
    if (leaves.length === 0) {
      throw new Error('Cannot build Merkle tree with no leaves');
    }

    // store all levels of the tree for proof generation
    const levels: string[][] = [leaves];
    let currentLevel = leaves;

    // build tree bottom-up
    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i] as `0x${string}`;
        const right = (
          i + 1 < currentLevel.length ? currentLevel[i + 1] : left
        ) as `0x${string}`;

        // sort hashes using strict comparison to match OpenZeppelin
        const [sortedLeft, sortedRight] =
          left < right ? [left, right] : [right, left];

        const combined = keccak256(
          encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
            sortedLeft,
            sortedRight,
          ]),
        );
        nextLevel.push(combined);
      }

      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    const root = currentLevel[0];

    // generate proofs for each leaf
    const proofs: string[][] = [];
    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
      const proof = this.generateProof(levels, leafIndex);
      proofs.push(proof);
    }

    return { root, proofs };
  }

  // generate Merkle proof for a specific leaf
  private generateProof(levels: string[][], leafIndex: number): string[] {
    const proof: string[] = [];
    let currentIndex = leafIndex;

    // traverse up the tree, collecting sibling hashes
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex++) {
      const level = levels[levelIndex];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < level.length) {
        proof.push(level[siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  // verify a Merkle proof
  verifyProof(leaf: string, proof: string[], root: string): boolean {
    let computedHash = leaf;

    for (const proofElement of proof) {
      // sort hashes using strict comparison to match OpenZeppelin
      const [left, right] =
        computedHash < proofElement
          ? [computedHash, proofElement]
          : [proofElement, computedHash];

      computedHash = keccak256(
        encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
          left as `0x${string}`,
          right as `0x${string}`,
        ]),
      );
    }

    return computedHash === root;
  }

  // get total rewards from Merkle tree
  getTotalRewards(leaves: MerkleLeaf[]): {
    totalWorkerRewards: bigint;
    totalStakerRewards: bigint;
  } {
    let totalWorkerRewards = 0n;
    let totalStakerRewards = 0n;

    for (const leaf of leaves) {
      totalWorkerRewards += leaf.workerRewards.reduce(
        (sum, reward) => sum + reward,
        0n,
      );
      totalStakerRewards += leaf.stakerRewards.reduce(
        (sum, reward) => sum + reward,
        0n,
      );
    }

    return { totalWorkerRewards, totalStakerRewards };
  }
}
