import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { TaskContext } from '../common';

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

/**
 * Service for Merkle tree operations.
 * Extracted from DistributionService to improve modularity.
 * Maintains exact same merkle tree generation logic.
 */
@Injectable()
export class MerkleService {
  /**
   * Generate a Merkle Mountain Range tree for batch distribution.
   * This is the exact same logic from the original MerkleTreeService.
   *
   * @param workers - Array of workers with their rewards
   * @param batchSize - Number of workers per batch (default: 50)
   * @returns Merkle tree with root, leaves, and proofs
   */
  async generateTree(
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    batchSize: number = 50,
  ): Promise<MerkleTreeResult> {
    let ctx: TaskContext | null = null;
    try {
      ctx = new TaskContext('merkle:generate');
      ctx?.logger?.debug(
        `Generating Merkle tree for ${workers.length} workers with batch size ${batchSize}`,
      );
    } catch {
      // Ignore logging errors
    }

    // CRITICAL: Sort workers deterministically by workerId (same as original)
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
      // Ignore logging errors
    }

    const batches: MerkleLeaf[] = [];
    const leafHashes: string[] = [];

    // Create batches (same as original)
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
        // Ignore logging errors
      }
    }

    try {
      ctx?.logger?.debug(
        `Created ${batches.length} batches from ${sortedWorkers.length} workers`,
      );
    } catch {
      // Ignore logging errors
    }

    // Build Merkle tree (same as original)
    const { root, proofs } = this.buildMerkleTree(leafHashes);

    try {
      ctx?.logger?.debug(
        `Generated Merkle tree with root: ${root}, total batches: ${batches.length}`,
      );
    } catch {
      // Ignore logging errors
    }

    return {
      root,
      leaves: batches,
      proofs,
      totalBatches: batches.length,
    };
  }

  /**
   * Build a Merkle Mountain Range from leaf hashes.
   * This is the exact same implementation from the original service.
   *
   * @param leafHashes - Array of leaf hashes
   * @returns Root hash and proofs for each leaf
   */
  buildMerkleTree(leafHashes: string[]): {
    root: string;
    proofs: string[][];
  } {
    if (leafHashes.length === 0) {
      return {
        root: keccak256(encodeAbiParameters([], [])),
        proofs: [],
      };
    }

    if (leafHashes.length === 1) {
      return {
        root: leafHashes[0],
        proofs: [[]],
      };
    }

    // Build complete binary tree (same as original)
    const tree: string[][] = [leafHashes];
    let currentLevel = leafHashes;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          // Hash pair of nodes
          const combined = keccak256(
            encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
              currentLevel[i] as `0x${string}`,
              currentLevel[i + 1] as `0x${string}`,
            ]),
          );
          nextLevel.push(combined);
        } else {
          // Odd node, promote to next level
          nextLevel.push(currentLevel[i]);
        }
      }

      tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    const root = currentLevel[0];

    // Generate proofs for each leaf (same as original)
    const proofs: string[][] = [];

    for (let leafIndex = 0; leafIndex < leafHashes.length; leafIndex++) {
      const proof: string[] = [];
      let index = leafIndex;

      for (let level = 0; level < tree.length - 1; level++) {
        const levelSize = tree[level].length;
        const isRightNode = index % 2 === 1;
        const siblingIndex = isRightNode ? index - 1 : index + 1;

        if (siblingIndex < levelSize) {
          proof.push(tree[level][siblingIndex]);
        }

        index = Math.floor(index / 2);
      }

      proofs.push(proof);
    }

    return { root, proofs };
  }

  /**
   * Generate a single proof for a specific batch.
   * Used during recovery operations.
   */
  generateProof(tree: MerkleTreeResult, batchIndex: number): string[] {
    if (batchIndex >= tree.proofs.length) {
      throw new Error(`Invalid batch index: ${batchIndex}`);
    }
    return tree.proofs[batchIndex];
  }

  /**
   * Verify a merkle proof.
   * Used to validate batches before distribution.
   */
  verifyProof(root: string, leaf: MerkleLeaf, proof: string[]): boolean {
    let computedHash = leaf.leafHash;

    for (const proofElement of proof) {
      const hashes = [computedHash, proofElement].sort();
      computedHash = keccak256(
        encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
          hashes[0] as `0x${string}`,
          hashes[1] as `0x${string}`,
        ]),
      );
    }

    return computedHash === root;
  }
}
