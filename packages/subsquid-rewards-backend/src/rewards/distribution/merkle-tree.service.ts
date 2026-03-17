import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';

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
  private readonly logger = new Logger(MerkleTreeService.name);

  constructor(private configService: ConfigService) {}

  async generateMerkleTree(
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    batchSize?: number,
  ): Promise<MerkleTreeResult> {
    const maxBatchSize = this.configService.get<number>(
      'rewards.maxBatchSize',
      100,
    );
    const effectiveBatchSize = batchSize ?? maxBatchSize;

    // Sort workers deterministically by workerId to ensure consistent merkle tree
    const sortedWorkers = [...workers].sort((a, b) => {
      if (a.workerId < b.workerId) return -1;
      if (a.workerId > b.workerId) return 1;
      return 0;
    });

    const batches: MerkleLeaf[] = [];
    const leafHashes: string[] = [];

    for (let i = 0; i < sortedWorkers.length; i += effectiveBatchSize) {
      const batch = sortedWorkers.slice(i, i + effectiveBatchSize);

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
    }

    const { root, proofs } = this.buildMerkleTree(leafHashes);

    this.logger.log(
      `Merkle tree generated: root=${root}, ${batches.length} leaves, ${sortedWorkers.length} workers`,
    );

    return {
      root,
      leaves: batches,
      proofs,
      totalBatches: batches.length,
    };
  }

  private buildMerkleTree(leaves: string[]): {
    root: string;
    proofs: string[][];
  } {
    if (leaves.length === 0) {
      throw new Error('Cannot build Merkle tree with no leaves');
    }

    const levels: string[][] = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          const left = currentLevel[i] as `0x${string}`;
          const right = currentLevel[i + 1] as `0x${string}`;

          const [sortedLeft, sortedRight] =
            left < right ? [left, right] : [right, left];

          const combined = keccak256(
            encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
              sortedLeft,
              sortedRight,
            ]),
          );
          nextLevel.push(combined);
        } else {
          nextLevel.push(currentLevel[i]);
        }
      }

      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    const root = currentLevel[0];

    const proofs: string[][] = [];
    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
      const proof = this.generateProof(levels, leafIndex);
      proofs.push(proof);
    }

    return { root, proofs };
  }

  private generateProof(levels: string[][], leafIndex: number): string[] {
    const proof: string[] = [];
    let currentIndex = leafIndex;

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

  verifyProof(leaf: string, proof: string[], root: string): boolean {
    let computedHash = leaf;

    for (const proofElement of proof) {
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
