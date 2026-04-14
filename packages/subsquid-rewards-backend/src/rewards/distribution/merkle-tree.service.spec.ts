import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MerkleTreeService } from './merkle-tree.service';

describe('MerkleTreeService', () => {
  let service: MerkleTreeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerkleTreeService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: any) => {
              const config: Record<string, any> = {
                'rewards.commitmentBatchSize': 100,
              };
              return config[key] ?? defaultValue;
            },
          },
        },
      ],
    }).compile();

    service = module.get<MerkleTreeService>(MerkleTreeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateMerkleTree', () => {
    it('should throw on empty workers input', async () => {
      await expect(service.generateMerkleTree([], 10)).rejects.toThrow(
        'Cannot build Merkle tree with no leaves',
      );
    });

    it('should generate a merkle tree with single worker', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 1);

      expect(result.root).toBeTruthy();
      expect(result.leaves).toHaveLength(1);
      expect(result.proofs).toHaveLength(1);
      expect(result.totalBatches).toBe(1);
      expect(result.leaves[0].recipients).toEqual([1n]);
      expect(result.leaves[0].workerRewards).toEqual([1000n]);
      expect(result.leaves[0].stakerRewards).toEqual([500n]);
    });

    it('should generate a merkle tree with multiple workers in single batch', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 10);

      expect(result.root).toBeTruthy();
      expect(result.leaves).toHaveLength(1);
      expect(result.proofs).toHaveLength(1);
      expect(result.totalBatches).toBe(1);
      expect(result.leaves[0].recipients).toHaveLength(2);
      expect(result.leaves[0].recipients).toEqual([1n, 2n]);
    });

    it('should generate a merkle tree with multiple batches', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
        {
          workerId: 3n,
          workerReward: 3000n,
          stakerReward: 1500n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 2);

      expect(result.root).toBeTruthy();
      expect(result.leaves).toHaveLength(2);
      expect(result.proofs).toHaveLength(2);
      expect(result.totalBatches).toBe(2);

      // first batch should have 2 workers
      expect(result.leaves[0].recipients).toHaveLength(2);
      // second batch should have 1 worker
      expect(result.leaves[1].recipients).toHaveLength(1);
    });

    it('should sort workers deterministically by workerId', async () => {
      const workers = [
        {
          workerId: 3n,
          workerReward: 3000n,
          stakerReward: 1500n,
        },
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 10);

      expect(result.leaves[0].recipients).toEqual([1n, 2n, 3n]); // should be sorted
      expect(result.leaves[0].workerRewards).toEqual([1000n, 2000n, 3000n]);
      expect(result.leaves[0].stakerRewards).toEqual([500n, 1000n, 1500n]);
    });

    it('should generate consistent merkle roots for same input', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
      ];

      const result1 = await service.generateMerkleTree(workers, 2);
      const result2 = await service.generateMerkleTree(workers, 2);

      expect(result1.root).toBe(result2.root);
    });
  });

  describe('verifyProof', () => {
    it('should verify a valid merkle proof', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 1);
      const leafHash = result.leaves[0].leafHash;
      const proof = result.proofs[0];
      const root = result.root;

      const isValid = service.verifyProof(leafHash, proof, root);
      expect(isValid).toBe(true);
    });

    it('should reject an invalid merkle proof', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 1);
      const leafHash = result.leaves[0].leafHash;
      const invalidProof = [
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ];
      const root = result.root;

      const isValid = service.verifyProof(leafHash, invalidProof, root);
      expect(isValid).toBe(false);
    });
  });

  describe('getTotalRewards', () => {
    it('should calculate total rewards correctly', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 1);
      const totals = service.getTotalRewards(result.leaves);

      expect(totals.totalWorkerRewards).toBe(3000n);
      expect(totals.totalStakerRewards).toBe(1500n);
    });

    it('should handle multiple batches correctly', async () => {
      const workers = [
        {
          workerId: 1n,
          workerReward: 1000n,
          stakerReward: 500n,
        },
        {
          workerId: 2n,
          workerReward: 2000n,
          stakerReward: 1000n,
        },
        {
          workerId: 3n,
          workerReward: 3000n,
          stakerReward: 1500n,
        },
      ];

      const result = await service.generateMerkleTree(workers, 2);
      const totals = service.getTotalRewards(result.leaves);

      expect(totals.totalWorkerRewards).toBe(6000n);
      expect(totals.totalStakerRewards).toBe(3000n);
    });
  });
});
