import { Injectable, Logger } from '@nestjs/common';
import { keccak256, encodePacked } from 'viem';

export interface MerkleLeaf {
  recipients: bigint[];
  workerRewards: bigint[];
  stakerRewards: bigint[];
}

export interface MerkleTreeResult {
  root: string;
  leaves: MerkleLeaf[];
  proofs: string[][];
  totalBatches: number;
}

@Injectable()
export class MerkleTreeService {
  private readonly logger = new Logger(MerkleTreeService.name);

  async generateMerkleTree(
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    batchSize: number = 50,
  ): Promise<MerkleTreeResult> {
    this.logger.log(
      `Generating Merkle tree for ${workers.length} workers with batch size ${batchSize}`,
    );

    const batches: MerkleLeaf[] = [];
    for (let i = 0; i < workers.length; i += batchSize) {
      const batch = workers.slice(i, i + batchSize);

      batches.push({
        recipients: batch.map((w) => w.workerId),
        workerRewards: batch.map((w) => w.workerReward),
        stakerRewards: batch.map((w) => w.stakerReward),
      });
    }

    this.logger.log(
      `Created ${batches.length} batches from ${workers.length} workers`,
    );

    // generate leaf hashes
    const leafHashes = batches.map((batch, index) => {
      const hash = keccak256(
        encodePacked(
          ['uint256[]', 'uint256[]', 'uint256[]'],
          [batch.recipients, batch.workerRewards, batch.stakerRewards],
        ),
      );

      this.logger.debug(
        `Batch ${index}: ${batch.recipients.length} workers, hash: ${hash}`,
      );
      return hash;
    });

    // build Merkle tree
    const { root, proofs } = this.buildMerkleTree(leafHashes);

    this.logger.log(
      `✅ Merkle tree generated: root=${root}, ${batches.length} leaves`,
    );

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

        // sort hashes to ensure deterministic tree
        const [sortedLeft, sortedRight] =
          left <= right ? [left, right] : [right, left];
        const combined = keccak256(
          encodePacked(['bytes32', 'bytes32'], [sortedLeft, sortedRight]),
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
      // sort hashes to match tree construction
      const [left, right] =
        computedHash <= proofElement
          ? [computedHash, proofElement]
          : [proofElement, computedHash];

      computedHash = keccak256(
        encodePacked(
          ['bytes32', 'bytes32'],
          [left as `0x${string}`, right as `0x${string}`],
        ),
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
