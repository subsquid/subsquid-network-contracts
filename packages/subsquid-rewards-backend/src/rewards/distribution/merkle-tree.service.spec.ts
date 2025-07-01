import { Test, TestingModule } from '@nestjs/testing';
import { MerkleTreeService } from './merkle-tree.service';

describe('MerkleTreeService', () => {
  let service: MerkleTreeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MerkleTreeService],
    }).compile();

    service = module.get<MerkleTreeService>(MerkleTreeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateBatchHash', () => {
    it('should generate correct batch hash for contract compatibility', () => {
      const recipients = [1, 2, 3];
      const workerRewards = [
        '1000000000000000000',
        '2000000000000000000',
        '3000000000000000000',
      ]; // 1, 2, 3 SQD
      const stakerRewards = [
        '100000000000000000',
        '200000000000000000',
        '300000000000000000',
      ]; // 0.1, 0.2, 0.3 SQD

      const hash = service.generateBatchHash(
        recipients,
        workerRewards,
        stakerRewards,
      );

      // Should return a valid keccak256 hash
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(hash.length).toBe(66); // 0x + 64 hex characters
    });

    it('should generate different hashes for different batches', () => {
      const batch1 = {
        recipients: [1, 2, 3],
        workerRewards: ['1000', '2000', '3000'],
        stakerRewards: ['100', '200', '300'],
      };

      const batch2 = {
        recipients: [4, 5, 6],
        workerRewards: ['4000', '5000', '6000'],
        stakerRewards: ['400', '500', '600'],
      };

      const hash1 = service.generateBatchHash(
        batch1.recipients,
        batch1.workerRewards,
        batch1.stakerRewards,
      );
      const hash2 = service.generateBatchHash(
        batch2.recipients,
        batch2.workerRewards,
        batch2.stakerRewards,
      );

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('createBatches', () => {
    it('should create batches with correct structure', () => {
      const workers = [
        {
          workerId: 1,
          workerReward: '1000000000000000000',
          stakerReward: '100000000000000000',
        },
        {
          workerId: 2,
          workerReward: '2000000000000000000',
          stakerReward: '200000000000000000',
        },
        {
          workerId: 3,
          workerReward: '3000000000000000000',
          stakerReward: '300000000000000000',
        },
        {
          workerId: 4,
          workerReward: '4000000000000000000',
          stakerReward: '400000000000000000',
        },
        {
          workerId: 5,
          workerReward: '5000000000000000000',
          stakerReward: '500000000000000000',
        },
      ];

      const batches = service.createBatches(workers, 2);

      expect(batches).toHaveLength(3); // 5 workers, batch size 2 = 3 batches (2+2+1)

      // First batch
      expect(batches[0].recipients).toEqual([1, 2]);
      expect(batches[0].workerRewards).toEqual([
        '1000000000000000000',
        '2000000000000000000',
      ]);
      expect(batches[0].stakerRewards).toEqual([
        '100000000000000000',
        '200000000000000000',
      ]);
      expect(batches[0].leafHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Last batch (odd worker)
      expect(batches[2].recipients).toEqual([5]);
      expect(batches[2].workerRewards).toEqual(['5000000000000000000']);
      expect(batches[2].stakerRewards).toEqual(['500000000000000000']);
    });
  });

  describe('buildMerkleTree', () => {
    it('should build Merkle tree and generate valid proofs', () => {
      // create test batches
      const workers = [
        {
          workerId: 1,
          workerReward: '1000000000000000000',
          stakerReward: '100000000000000000',
        },
        {
          workerId: 2,
          workerReward: '2000000000000000000',
          stakerReward: '200000000000000000',
        },
        {
          workerId: 3,
          workerReward: '3000000000000000000',
          stakerReward: '300000000000000000',
        },
      ];

      const batches = service.createBatches(workers, 2); // should create 2 batches
      const merkleData = service.buildMerkleTree(batches);

      expect(merkleData.root).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(merkleData.leaves).toHaveLength(2);
      expect(Object.keys(merkleData.proofs)).toHaveLength(2);

      // Verify all proofs
      for (let i = 0; i < batches.length; i++) {
        const isValid = service.verifyProof(
          merkleData.leaves[i],
          merkleData.proofs[i],
          merkleData.root,
        );
        expect(isValid).toBe(true);
      }
    });

    it('should handle single batch correctly', () => {
      const workers = [
        {
          workerId: 1,
          workerReward: '1000000000000000000',
          stakerReward: '100000000000000000',
        },
      ];

      const batches = service.createBatches(workers, 10); // Single batch
      const merkleData = service.buildMerkleTree(batches);

      expect(merkleData.root).toBe(batches[0].leafHash); // Root equals single leaf
      expect(merkleData.proofs[0]).toHaveLength(0); // No proof needed for single leaf

      const isValid = service.verifyProof(
        merkleData.leaves[0],
        merkleData.proofs[0],
        merkleData.root,
      );
      expect(isValid).toBe(true);
    });

    it('should match reference implementation from generate_merkle.mjs', () => {
      // Using the exact same test data as in generate_merkle.mjs
      const testBatches = [
        {
          batchId: 0,
          recipients: [1, 2, 3],
          workerRewards: [
            '1000000000000000000',
            '2000000000000000000',
            '1500000000000000000',
          ],
          stakerRewards: [
            '100000000000000000',
            '200000000000000000',
            '150000000000000000',
          ],
          leafHash: '',
        },
        {
          batchId: 1,
          recipients: [4, 5],
          workerRewards: ['3000000000000000000', '2500000000000000000'],
          stakerRewards: ['300000000000000000', '250000000000000000'],
          leafHash: '',
        },
        {
          batchId: 2,
          recipients: [6, 7, 8],
          workerRewards: [
            '1800000000000000000',
            '2200000000000000000',
            '1600000000000000000',
          ],
          stakerRewards: [
            '180000000000000000',
            '220000000000000000',
            '160000000000000000',
          ],
          leafHash: '',
        },
      ];

      // Generate leaf hashes
      testBatches.forEach((batch) => {
        batch.leafHash = service.generateBatchHash(
          batch.recipients,
          batch.workerRewards,
          batch.stakerRewards,
        );
      });

      const merkleData = service.buildMerkleTree(testBatches);

      // All proofs should be valid
      for (let i = 0; i < testBatches.length; i++) {
        const isValid = service.verifyProof(
          testBatches[i].leafHash,
          merkleData.proofs[i],
          merkleData.root,
        );
        expect(isValid).toBe(true);
      }

      // Root should be a valid hash
      expect(merkleData.root).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
  });

  describe('verifyProof', () => {
    it('should reject invalid proofs', () => {
      const workers = [
        {
          workerId: 1,
          workerReward: '1000000000000000000',
          stakerReward: '100000000000000000',
        },
        {
          workerId: 2,
          workerReward: '2000000000000000000',
          stakerReward: '200000000000000000',
        },
      ];

      const batches = service.createBatches(workers, 1);
      const merkleData = service.buildMerkleTree(batches);

      // Use wrong leaf with correct proof
      const wrongLeaf =
        '0x1234567890123456789012345678901234567890123456789012345678901234';
      const isValid = service.verifyProof(
        wrongLeaf,
        merkleData.proofs[0],
        merkleData.root,
      );
      expect(isValid).toBe(false);

      // Use correct leaf with wrong proof
      const wrongProof = [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
      ];
      const isValid2 = service.verifyProof(
        merkleData.leaves[0],
        wrongProof,
        merkleData.root,
      );
      expect(isValid2).toBe(false);
    });
  });
});
