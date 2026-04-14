// Contract ABIs extracted from packages/contracts/artifacts/
// These are copies to ensure our backend has its own stable version

export const DistributedRewardsDistributionABI = [
  // Errors
  { type: 'error', name: 'ArrayLengthMismatch', inputs: [] },
  { type: 'error', name: 'BatchAlreadyProcessed', inputs: [] },
  { type: 'error', name: 'InvalidMerkleProof', inputs: [] },
  { type: 'error', name: 'MerkleRootNotCommitted', inputs: [] },
  { type: 'error', name: 'NotEnoughApprovals', inputs: [] },
  { type: 'error', name: 'NotAllBlocksCovered', inputs: [] },
  { type: 'error', name: 'CommitmentAlreadyCompleted', inputs: [] },
  { type: 'error', name: 'AlreadyApproved', inputs: [] },
  {
    type: 'constructor',
    inputs: [
      { name: '_router', type: 'address', internalType: 'contract IRouter' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'DEFAULT_ADMIN_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REWARDS_DISTRIBUTOR_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'canCommit',
    inputs: [{ name: 'who', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'commitRoot',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
      { name: 'root', type: 'bytes32', internalType: 'bytes32' },
      { name: 'totalBatches', type: 'uint16', internalType: 'uint16' },
      { name: 'ipfs', type: 'string', internalType: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approveRoot',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'distribute',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
      { name: 'recipients', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'workerRewards', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'stakerRewards', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'merkleProof', type: 'bytes32[]', internalType: 'bytes32[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'commitments',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'status', type: 'uint8', internalType: 'uint8' },
      { name: 'fromBlock', type: 'uint256', internalType: 'uint256' },
      { name: 'toBlock', type: 'uint256', internalType: 'uint256' },
      { name: 'merkleRoot', type: 'bytes32', internalType: 'bytes32' },
      { name: 'totalBatches', type: 'uint16', internalType: 'uint16' },
      { name: 'processedBatches', type: 'uint16', internalType: 'uint16' },
      { name: 'approvalCount', type: 'uint256', internalType: 'uint256' },
      { name: 'ipfsLink', type: 'string', internalType: 'string' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approvedBy',
    inputs: [
      { name: '', type: 'bytes32', internalType: 'bytes32' },
      { name: '', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'processed',
    inputs: [
      { name: '', type: 'bytes32', internalType: 'bytes32' },
      { name: '', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'lastBlockRewarded',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'lastCommitmentKey',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'requiredApproves',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'roundRobinBlocks',
    inputs: [],
    outputs: [{ name: '', type: 'uint128', internalType: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'windowSize',
    inputs: [],
    outputs: [{ name: '', type: 'uint128', internalType: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'addDistributor',
    inputs: [{ name: 'distributor', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setApprovesRequired',
    inputs: [
      { name: 'approvesRequired', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setRoundRobinBlocks',
    inputs: [{ name: 'n', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setWindowSize',
    inputs: [{ name: 'n', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getCommitment',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
    ],
    outputs: [
      { name: 'status', type: 'uint8', internalType: 'uint8' },
      { name: 'merkleRoot', type: 'bytes32', internalType: 'bytes32' },
      { name: 'totalBatches', type: 'uint16', internalType: 'uint16' },
      { name: 'processedBatches', type: 'uint16', internalType: 'uint16' },
      { name: 'approvalCount', type: 'uint256', internalType: 'uint256' },
      { name: 'ipfsLink', type: 'string', internalType: 'string' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isCommitmentComplete',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
    ],
    outputs: [{ name: 'isComplete', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'canAcceptDistributions',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
    ],
    outputs: [{ name: 'canDistribute', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'clearCommitment',
    inputs: [
      { name: 'blockRange', type: 'uint256[2]', internalType: 'uint256[2]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setLastRewardedBlock',
    inputs: [{ name: 'blockNumber', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'workerId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: 'reward', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimable',
    inputs: [{ name: 'workerId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: 'reward', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'accumulativeRewardOf',
    inputs: [{ name: 'workerId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: 'reward', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'withdrawableRewardOf',
    inputs: [{ name: 'workerId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: 'reward', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'NewCommitment',
    inputs: [
      {
        name: 'committer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'fromBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },

      {
        name: 'toBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'merkleRoot',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Approved',
    inputs: [
      {
        name: 'approver',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'fromBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'toBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'merkleRoot',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'ipfsLink',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BatchDistributed',
    inputs: [
      {
        name: 'fromBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'toBlock',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'batchId',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'recipients',
        type: 'uint256[]',
        indexed: false,
        internalType: 'uint256[]',
      },
      {
        name: 'workerRewards',
        type: 'uint256[]',
        indexed: false,
        internalType: 'uint256[]',
      },
      {
        name: 'stakerRewards',
        type: 'uint256[]',
        indexed: false,
        internalType: 'uint256[]',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RewardClaimed',
    inputs: [
      {
        name: 'worker',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'workerId',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CommitmentCleared',
    inputs: [
      {
        name: 'fromBlock',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'toBlock',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'commitmentKey',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'previousStatus',
        type: 'uint8',
        indexed: false,
        internalType: 'enum DistributedRewardsDistribution.CommitmentStatus',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'LastRewardedBlockUpdated',
    inputs: [
      {
        name: 'previousBlock',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'newBlock',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
] as const;

// Basic RewardCalculation ABI (key functions)
export const RewardCalculationABI = [
  {
    type: 'function',
    name: 'effectiveTVL',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'currentApy',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'INITIAL_REWARD_POOL_SIZE',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'boostFactor',
    inputs: [{ name: 'duration', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'pure',
  },
] as const;

// Basic WorkerRegistration ABI (key functions)
export const WorkerRegistrationABI = [
  {
    type: 'function',
    name: 'epochLength',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'bondAmount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getActiveWorkerCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registeredWorkersCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'storagePerWorkerInGb',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'targetCapacity',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'workerIds',
    inputs: [{ name: 'peerId', type: 'bytes', internalType: 'bytes' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'WorkerRegistered',
    inputs: [
      {
        name: 'workerId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      { name: 'peerId', type: 'bytes', indexed: false, internalType: 'bytes' },
      {
        name: 'registrar',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'registeredAt',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'metadata',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
] as const;

// Basic NetworkController ABI (key functions)
export const NetworkControllerABI = [
  {
    type: 'function',
    name: 'nextEpoch',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'yearlyRewardCapCoefficient',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'targetCapacityGb',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'storagePerWorkerInGb',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// Staking contract ABI (key functions for stake queries)
export const StakingABI = [
  {
    type: 'function',
    name: 'delegated',
    inputs: [{ name: 'worker', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'stake',
    inputs: [{ name: 'worker', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export const CapedStakingABI = [
  {
    type: 'function',
    name: 'capedStake',
    inputs: [{ name: 'worker', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const;
