import { Test, TestingModule } from '@nestjs/testing';
import { DistributionDemoService, WorkerReward } from './distribution-demo.service';
import { MerkleTreeService } from './merkle-tree.service';

describe('DistributionDemoService', () => {
  let service: DistributionDemoService;
  let merkleTreeService: MerkleTreeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DistributionDemoService, MerkleTreeService],
    }).compile();

    service = module.get<DistributionDemoService>(DistributionDemoService);
    merkleTreeService = module.get<MerkleTreeService>(MerkleTreeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createDistributionCommitment', () => {
    it('should create a valid distribution commitment', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
        { workerId: 2, workerReward: '2000000000000000000', stakerReward: '200000000000000000' },
        { workerId: 3, workerReward: '3000000000000000000', stakerReward: '300000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'test-epoch-1',
        1000,
        2000,
        workerRewards,
        2, // batch size
        'ipfs://test-link'
      );

      expect(commitment.epochId).toBe('test-epoch-1');
      expect(commitment.fromBlock).toBe(1000);
      expect(commitment.toBlock).toBe(2000);
      expect(commitment.totalWorkers).toBe(3);
      expect(commitment.totalBatches).toBe(2); // 3 workers, batch size 2 = 2 batches
      expect(commitment.merkleRoot).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(commitment.ipfsLink).toBe('ipfs://test-link');

      // Check total rewards calculation
      expect(commitment.totalWorkerRewards).toBe('6000000000000000000'); // 1+2+3 SQD
      expect(commitment.totalStakerRewards).toBe('600000000000000000'); // 0.1+0.2+0.3 SQD

      // Check batches structure
      expect(commitment.batches).toHaveLength(2);
      
      // First batch should have 2 workers
      expect(commitment.batches[0].recipients).toEqual([1, 2]);
      expect(commitment.batches[0].workerRewards).toEqual(['1000000000000000000', '2000000000000000000']);
      expect(commitment.batches[0].stakerRewards).toEqual(['100000000000000000', '200000000000000000']);
      expect(commitment.batches[0].proof).toBeInstanceOf(Array);

      // Second batch should have 1 worker
      expect(commitment.batches[1].recipients).toEqual([3]);
      expect(commitment.batches[1].workerRewards).toEqual(['3000000000000000000']);
      expect(commitment.batches[1].stakerRewards).toEqual(['300000000000000000']);
      expect(commitment.batches[1].proof).toBeInstanceOf(Array);
    });

    it('should handle single worker correctly', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'single-worker',
        1000,
        2000,
        workerRewards,
        10
      );

      expect(commitment.totalWorkers).toBe(1);
      expect(commitment.totalBatches).toBe(1);
      expect(commitment.batches[0].recipients).toEqual([1]);
      expect(commitment.batches[0].proof).toHaveLength(0); // No proof needed for single leaf
    });

    it('should throw error if proofs are invalid', async () => {
      // Mock the verifyProof method to return false
      jest.spyOn(merkleTreeService, 'verifyProof').mockReturnValue(false);

      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
      ];

      await expect(
        service.createDistributionCommitment('test', 1000, 2000, workerRewards)
      ).rejects.toThrow('Some Merkle proofs are invalid');
    });
  });

  describe('demonstrateDistributionFlow', () => {
    it('should demonstrate complete distribution flow', async () => {
      const commitment = await service.demonstrateDistributionFlow();

      expect(commitment.epochId).toBe('1000000-1010000');
      expect(commitment.fromBlock).toBe(1000000);
      expect(commitment.toBlock).toBe(1010000);
      expect(commitment.totalWorkers).toBe(7);
      expect(commitment.totalBatches).toBe(3); // 7 workers, batch size 3 = 3 batches
      expect(commitment.merkleRoot).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(commitment.ipfsLink).toBe('ipfs://QmSampleMerkleTreeImplementation');

      // All batches should have valid proofs
      for (const batch of commitment.batches) {
        expect(batch.proof).toBeInstanceOf(Array);
        expect(batch.leafHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        
        const isValid = merkleTreeService.verifyProof(batch.leafHash, batch.proof, commitment.merkleRoot);
        expect(isValid).toBe(true);
      }
    });
  });

  describe('getContractDistributionData', () => {
    it('should return correct contract data for distribution', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
        { workerId: 2, workerReward: '2000000000000000000', stakerReward: '200000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'test',
        1000,
        2000,
        workerRewards,
        2
      );

      const contractData = service.getContractDistributionData(commitment, 0);

      expect(contractData.blockRange).toEqual([1000, 2000]);
      expect(contractData.recipients).toEqual([1, 2]);
      expect(contractData.workerRewards).toEqual(['1000000000000000000', '2000000000000000000']);
      expect(contractData.stakerRewards).toEqual(['100000000000000000', '200000000000000000']);
      expect(contractData.merkleProof).toBeInstanceOf(Array);
      expect(contractData.merkleRoot).toBe(commitment.merkleRoot);
      expect(contractData.leafHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(contractData.batchId).toBe(0);
    });

    it('should throw error for invalid batch index', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'test',
        1000,
        2000,
        workerRewards,
        2
      );

      expect(() => service.getContractDistributionData(commitment, 5)).toThrow(
        'Batch index 5 out of range'
      );
    });
  });

  describe('getContractCommitmentData', () => {
    it('should return correct contract data for commitment', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
        { workerId: 2, workerReward: '2000000000000000000', stakerReward: '200000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'test-epoch',
        1000,
        2000,
        workerRewards,
        2,
        'ipfs://test'
      );

      const contractData = service.getContractCommitmentData(commitment);

      expect(contractData.blockRange).toEqual([1000, 2000]);
      expect(contractData.merkleRoot).toBe(commitment.merkleRoot);
      expect(contractData.totalBatches).toBe(1);
      expect(contractData.ipfsLink).toBe('ipfs://test');
      expect(contractData.epochId).toBe('test-epoch');
      expect(contractData.totalWorkers).toBe(2);
      expect(contractData.totalWorkerRewards).toBe('3000000000000000000');
      expect(contractData.totalStakerRewards).toBe('300000000000000000');
    });

    it('should use default IPFS link if none provided', async () => {
      const workerRewards: WorkerReward[] = [
        { workerId: 1, workerReward: '1000000000000000000', stakerReward: '100000000000000000' },
      ];

      const commitment = await service.createDistributionCommitment(
        'test',
        1000,
        2000,
        workerRewards
      );

      const contractData = service.getContractCommitmentData(commitment);
      expect(contractData.ipfsLink).toBe('ipfs://QmDefaultLink');
    });
  });
}); 