// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {DistributedRewardsDistribution} from "../../src/DistributedRewardDistribution.sol";
import {MerkleMountainRange} from "../../src/mmr/MerkleMountainRange.sol";
import {Node, MmrLeaf, Iterator, StorageValue} from "../../src/mmr/Types.sol";
import {IWorkerRegistration, WorkerRegistration} from "../../src/WorkerRegistration.sol";
import {IStaking, Staking} from "../../src/Staking.sol";
import {INetworkController, NetworkController} from "../../src/NetworkController.sol";
import {IRewardCalculation, RewardCalculation} from "../../src/RewardCalculation.sol";
import {SoftCap} from "../../src/SoftCap.sol";
import {Router, IRouter} from "../../src/Router.sol";
import {IERC20} from "../../src/SQD.sol";

contract DistributedRewardsDistributionTest is Test {
  DistributedRewardsDistribution public rewardsDistribution;
  Router public router;
  Staking public staking;
  WorkerRegistration public workerRegistration;
  NetworkController public networkController;
  RewardCalculation public rewardCalculation;
  SoftCap public softCap;
  SQD public sqdToken;

  address public admin = address(0x1);
  address public distributor1 = address(0x2);
  address public distributor2 = address(0x3);
  address public treasury = address(0x4);
  address public workerOwner = address(0x5);

  uint256[] public workerIds;
  uint256[] public amounts;

  bytes32[] public mmrNodes;
  bytes32 public mmrRoot;
  uint256 public fromBlock = 100;
  uint256 public toBlock = 200;
  uint256 public batchCount = 2;

  event NewCommitment(address indexed distributor, uint256 fromBlock, uint256 toBlock, bytes32 root);
  event Approved(address indexed distributor, uint256 fromBlock, uint256 toBlock, bytes32 root, string ipfsLink);
  event BatchDistributed(
    uint256 fromBlock,
    uint256 toBlock,
    uint256 batchId,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards
  );
  event RewardClaimed(address indexed user, uint256 indexed workerId, uint256 amount);
  event FinalRootCommitted(bytes32 indexed blockRangeKey, bytes32 finalRoot, uint64 totalLeaves, address committer);
  event FinalRootApproved(bytes32 indexed blockRangeKey, bytes32 finalRoot, address approver);

  bytes32[100] private tmp;

  function _height(uint256 pos) internal pure returns (uint256 h) {
    while (((pos + 1) & (1 << h)) == 0) ++h;
  }

  function _getPeaks(uint256 leaves) internal pure returns (uint256[] memory) {
    uint256[] memory buf = new uint256[](64); // scratch, fits any 2⁶ leaves
    uint256 count;
    uint256 bit = 1;
    uint256 pos = leaves - 1; // start at right-most node

    while (bit <= leaves) {
      if (leaves & bit != 0) {
        buf[count++] = pos; // collect peak
        pos -= (bit << 1) - 1; // jump over perfect subtree
      }
      bit <<= 1;
    }

    uint256[] memory peaks = new uint256[](count);
    for (uint256 i = 0; i < count; ++i) {
      peaks[i] = buf[count - 1 - i];
    } // left-to-right order

    return peaks;
  }

  function _bag(uint256[] memory peaks, bytes32[] memory nodes) internal pure returns (bytes32 root) {
    root = nodes[peaks[peaks.length - 1]];
    for (uint256 i = peaks.length - 1; i > 0; i--) {
      root = keccak256(abi.encodePacked(nodes[peaks[i - 1]], root));
    }
  }

  function _generateMMR(bytes32[] memory leafHashes) internal pure returns (bytes32 root, bytes32[] memory nodes) {
    nodes = new bytes32[](leafHashes.length * 2); // upper bound
    uint256 n; // nodes used

    /* push leaves */
    for (uint256 i; i < leafHashes.length; i++) {
      nodes[n++] = leafHashes[i];
    }

    /* build parents */
    uint256 layer = leafHashes.length;
    uint256 off = 0;
    while (layer > 1) {
      for (uint256 i; i + 1 < layer; i += 2) {
        nodes[n++] = keccak256(abi.encodePacked(nodes[off + i], nodes[off + i + 1]));
      }
      if (layer & 1 == 1) nodes[n++] = nodes[off + layer - 1]; // promote odd
      off += layer;
      layer = (layer + 1) >> 1;
    }
    assembly {
      mstore(nodes, n)
    } // shrink array
    root = _bag(_getPeaks(leafHashes.length), nodes);
  }

  function _proof(uint256 leafPos, bytes32[] memory nodes, uint256 leafCount)
    internal
    returns (bytes32[] memory proof, uint64 kIndex)
  {
    uint256[] memory peaks = _getPeaks(leafCount);
    uint256 p; // length

    uint256 cur = leafPos;
    while (true) {
      bool isPeak = false;
      for (uint256 i; i < peaks.length; ++i) {
        if (peaks[i] == cur) {
          isPeak = true;
          break;
        }
      }
      if (isPeak) break;
      uint256 sib = cur ^ (1 << _height(cur));
      tmp[p++] = nodes[sib];
      cur = (cur & ~(1 << _height(cur))) | (1 << (_height(cur) + 1)); // parent
    }
    for (uint256 i = peaks.length; i > 0; --i) {
      if (peaks[i - 1] == cur) break;
      tmp[p++] = nodes[peaks[i - 1]];
    }
    proof = new bytes32[](p);
    for (uint256 i; i < p; ++i) {
      proof[i] = tmp[i];
    }

    uint256 peakHeight = _height(cur);
    uint256 leftMost = cur - ((1 << peakHeight) - 1);
    kIndex = uint64(leafPos - leftMost);
  }

  function setUp() public {
    vm.startPrank(admin);

    sqdToken = new SQD();

    uint128 epochLength = 100;
    uint128 firstEpochBlock = 0;
    uint128 epochCheckpoint = 0;
    uint256 bondAmount = 1000 ether;
    address[] memory allowedVestedTargets = new address[](0);

    networkController =
      new NetworkController(epochLength, firstEpochBlock, epochCheckpoint, bondAmount, allowedVestedTargets);

    router = new Router();

    softCap = new SoftCap(router);

    rewardCalculation = new RewardCalculation(router, softCap);

    staking = new Staking(sqdToken, router);

    workerRegistration = new WorkerRegistration(sqdToken, router);

    router.initialize(workerRegistration, staking, treasury, networkController, rewardCalculation);

    vm.deal(treasury, 100 ether);

    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));

    rewardsDistribution = new DistributedRewardsDistribution(router);

    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_DISTRIBUTOR_ROLE(), distributor1);
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_DISTRIBUTOR_ROLE(), distributor2);
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_TREASURY_ROLE(), treasury);

    rewardsDistribution.addDistributor(distributor1);
    rewardsDistribution.addDistributor(distributor2);

    rewardsDistribution.setApprovesRequired(1);

    workerIds = new uint256[](5);
    amounts = new uint256[](5);

    workerIds[0] = 101;
    workerIds[1] = 203;
    workerIds[2] = 305;
    workerIds[3] = 407;
    workerIds[4] = 509;

    amounts[0] = 1000;
    amounts[1] = 2000;
    amounts[2] = 1500;
    amounts[3] = 3000;
    amounts[4] = 4000;

    sqdToken.mint(workerOwner, 1000000 ether);

    vm.stopPrank();
    vm.startPrank(workerOwner);

    sqdToken.approve(address(workerRegistration), type(uint256).max);

    for (uint256 i = 0; i < workerIds.length; i++) {
      bytes memory peerId = abi.encodePacked("peer", i);
      workerRegistration.register(peerId, "metadata");
      if (i == 0) {
        // for the first worker, use the actual registration
        workerRegistration.register(peerId, "metadata");
      }
    }

    vm.stopPrank();
    vm.startPrank(admin);

    // build MMR structure with new helper
    bytes32[] memory leaves = new bytes32[](4);
    for (uint256 i; i < 4; ++i) {
      leaves[i] = keccak256(abi.encode(workerIds[i], amounts[i]));
    }
    (mmrRoot, mmrNodes) = _generateMMR(leaves);

    uint256[] memory testWorkerIds = new uint256[](4);
    uint256[] memory testWorkerRewards = new uint256[](4);
    uint256[] memory testStakerRewards = new uint256[](4);

    for (uint256 i = 0; i < 4; i++) {
      testStakerRewards[i] = amounts[i] / 2;
      testWorkerIds[i] = workerIds[i];
      testWorkerRewards[i] = amounts[i];
    }

    uint256[] memory ownedWorkers = new uint256[](4);
    for (uint256 i = 0; i < 4; i++) {
      ownedWorkers[i] = testWorkerIds[i];
    }

    uint256[] memory mockOwnedWorkers = new uint256[](1);
    mockOwnedWorkers[0] = 101; // First workerId from the test

    vm.mockCall(
      address(workerRegistration),
      abi.encodeWithSelector(workerRegistration.getOwnedWorkers.selector, workerOwner),
      abi.encode(mockOwnedWorkers)
    );

    vm.mockCall(
      address(staking),
      abi.encodeWithSelector(staking.claim.selector, workerOwner),
      abi.encode(5000) // mockClaimableAmount
    );

    bytes32 testMmrRoot = mmrRoot;

    vm.stopPrank();
  }

  // helper function to ide  ntify the eligible committer at a given block
  function getEligibleCommitterAtBlock(uint256 blockNum) public view returns (address) {
    uint128 roundRobinBlocks = rewardsDistribution.roundRobinBlocks();

    uint256 distributorIndex = (blockNum / uint256(roundRobinBlocks)) % 2;

    return distributorIndex == 0 ? distributor1 : distributor2;
  }

  // helper function to convert bytes32 to hex string for logging
  function bytes32ToHexString(bytes32 value) internal pure returns (string memory) {
    bytes memory result = new bytes(64);
    bytes memory alphabet = "0123456789abcdef";

    for (uint256 i = 0; i < 32; i++) {
      result[i * 2] = alphabet[uint8(value[i] >> 4)];
      result[i * 2 + 1] = alphabet[uint8(value[i] & 0x0f)];
    }

    return string(result);
  }

  // helper function to calculate a batch leaf hash
  function calculateBatchHash(uint256[] memory workers, uint256[] memory workerRewards, uint256[] memory stakerRewards)
    internal
    pure
    returns (bytes32)
  {
    return keccak256(abi.encode(workers, workerRewards, stakerRewards));
  }

  /**
   * @notice Tests the entire workflow of distributing rewards using MMR with proper proofs
   */
  function testFullWorkflow() public {
    vm.startPrank(admin);

    uint256[] memory testWorkerIds = new uint256[](4);
    uint256[] memory testWorkerRewards = new uint256[](4);

    for (uint256 i = 0; i < 4; i++) {
      testWorkerIds[i] = workerIds[i];
      testWorkerRewards[i] = amounts[i];
    }

    uint256[] memory ownedWorkers = new uint256[](4);
    for (uint256 i = 0; i < 4; i++) {
      ownedWorkers[i] = testWorkerIds[i];
    }

    bytes32 testMmrRoot = mmrRoot;
    vm.stopPrank();

    uint256 testBlock = 256;
    vm.roll(testBlock);

    address eligibleCommitter = getEligibleCommitterAtBlock(testBlock);
    console.log("Eligible committer at block %d: %s", testBlock, eligibleCommitter);

    vm.startPrank(eligibleCommitter);

    assertTrue(rewardsDistribution.canCommit(eligibleCommitter), "Eligible committer should be able to commit");

    bytes32 blockRangeKey = keccak256(abi.encodePacked(fromBlock, toBlock));
    vm.expectEmit(true, true, true, true);
    emit FinalRootCommitted(blockRangeKey, testMmrRoot, 4, eligibleCommitter);

    rewardsDistribution.commitFinalRoot(
      [fromBlock, toBlock],
      testMmrRoot,
      4, // totalLeaves (4 worker batches)
      "ipfs://test-mmr"
    );

    vm.stopPrank();

    uint256[] memory batch1Workers = new uint256[](2);
    uint256[] memory batch1WorkerRewards = new uint256[](2);
    uint256[] memory batch1StakerRewards = new uint256[](2);

    batch1Workers[0] = testWorkerIds[0];
    batch1Workers[1] = testWorkerIds[1];
    batch1WorkerRewards[0] = testWorkerRewards[0];
    batch1WorkerRewards[1] = testWorkerRewards[1];
    batch1StakerRewards[0] = testWorkerRewards[0] / 2; // Half for stakers
    batch1StakerRewards[1] = testWorkerRewards[1] / 2;

    uint256[] memory batch2Workers = new uint256[](2);
    uint256[] memory batch2WorkerRewards = new uint256[](2);
    uint256[] memory batch2StakerRewards = new uint256[](2);

    batch2Workers[0] = testWorkerIds[2];
    batch2Workers[1] = testWorkerIds[3];
    batch2WorkerRewards[0] = testWorkerRewards[2];
    batch2WorkerRewards[1] = testWorkerRewards[3];
    batch2StakerRewards[0] = testWorkerRewards[2] / 2;
    batch2StakerRewards[1] = testWorkerRewards[3] / 2;

    (bytes32[] memory proof1, uint64 k1) = _proof(0, mmrNodes, 4);

    vm.expectEmit(true, true, true, true);
    emit BatchDistributed(
      fromBlock,
      toBlock,
      0, // batchId (leafIndex)
      batch1Workers,
      batch1WorkerRewards,
      batch1StakerRewards
    );

    rewardsDistribution.distributeBatch(
      [fromBlock, toBlock],
      k1, // kIndex (position in the subtree)
      0, // leafIndex (sequential position among leaves)
      batch1Workers,
      batch1WorkerRewards,
      batch1StakerRewards,
      proof1
    );

    assertEq(rewardsDistribution.withdrawableRewardOf(batch1Workers[0]), batch1WorkerRewards[0]);
    assertEq(rewardsDistribution.withdrawableRewardOf(batch1Workers[1]), batch1WorkerRewards[1]);

    (bytes32[] memory proof2, uint64 k2) = _proof(1, mmrNodes, 4);

    vm.expectEmit(true, true, true, true);
    emit BatchDistributed(
      fromBlock,
      toBlock,
      1, // batchId (leafIndex)
      batch2Workers,
      batch2WorkerRewards,
      batch2StakerRewards
    );

    rewardsDistribution.distributeBatch(
      [fromBlock, toBlock], k2, 1, batch2Workers, batch2WorkerRewards, batch2StakerRewards, proof2
    );

    assertEq(rewardsDistribution.withdrawableRewardOf(batch2Workers[0]), batch2WorkerRewards[0]);
    assertEq(rewardsDistribution.withdrawableRewardOf(batch2Workers[1]), batch2WorkerRewards[1]);

    uint256 stakerReward = 5000;

    vm.startPrank(treasury);
    vm.deal(address(rewardsDistribution), 50 ether);

    uint256 claimedAmount = rewardsDistribution.claim(workerOwner);

    assertEq(claimedAmount, testWorkerRewards[0]);

    for (uint256 i = 0; i < 4; i++) {
      if (i == 0) {
        assertEq(rewardsDistribution.withdrawableRewardOf(testWorkerIds[i]), 0);
      } else {
        assertEq(rewardsDistribution.withdrawableRewardOf(testWorkerIds[i]), testWorkerRewards[i]);
      }
    }

    vm.stopPrank();
  }

  function testLegacyFunctionsAndNewMMRFunctions() public {
    uint256 testBlock = 256;
    vm.roll(testBlock);

    address eligibleCommitter = getEligibleCommitterAtBlock(testBlock);
    console.log("Eligible committer at block %d: %s", testBlock, eligibleCommitter);

    vm.startPrank(eligibleCommitter);

    vm.expectEmit(true, true, true, true);
    emit NewCommitment(eligibleCommitter, fromBlock, toBlock, mmrRoot);

    bytes32 blockRangeKey = keccak256(abi.encodePacked(fromBlock, toBlock));
    vm.expectEmit(true, true, true, true);
    emit FinalRootCommitted(blockRangeKey, mmrRoot, 4, eligibleCommitter);

    rewardsDistribution.commitFinalRoot([fromBlock, toBlock], mmrRoot, 4, "ipfs://test");

    vm.stopPrank();

    address otherDistributor = eligibleCommitter == distributor1 ? distributor2 : distributor1;
    vm.startPrank(otherDistributor);

    vm.expectEmit(true, true, true, true);
    emit FinalRootApproved(blockRangeKey, mmrRoot, otherDistributor);

    rewardsDistribution.approveFinalRoot([fromBlock, toBlock], mmrRoot);

    vm.stopPrank();

    uint256 testBlock2 = testBlock + 256;
    vm.roll(testBlock2);

    eligibleCommitter = getEligibleCommitterAtBlock(testBlock2);
    console.log("Eligible committer at block %d: %s", testBlock2, eligibleCommitter);

    vm.startPrank(eligibleCommitter);

    blockRangeKey = keccak256(abi.encodePacked(fromBlock + 300, toBlock + 300));

    vm.expectEmit(true, true, true, true);
    emit FinalRootCommitted(blockRangeKey, mmrRoot, 4, eligibleCommitter);

    rewardsDistribution.commitFinalRoot([fromBlock + 300, toBlock + 300], mmrRoot, 4, "ipfs://test-mmr-new");

    vm.stopPrank();

    otherDistributor = eligibleCommitter == distributor1 ? distributor2 : distributor1;
    vm.startPrank(otherDistributor);

    vm.expectEmit(true, true, true, true);
    emit FinalRootApproved(blockRangeKey, mmrRoot, otherDistributor);

    rewardsDistribution.approveFinalRoot([fromBlock + 300, toBlock + 300], mmrRoot);

    vm.stopPrank();
  }

  function testMMRProofVerification() public {
    uint256 testBlock = 256;
    vm.roll(testBlock);

    address eligibleCommitter = getEligibleCommitterAtBlock(testBlock);
    console.log("Eligible committer at block %d: %s", testBlock, eligibleCommitter);

    vm.startPrank(eligibleCommitter);

    rewardsDistribution.commitFinalRoot([fromBlock, toBlock], mmrRoot, 4, "ipfs://test-mmr");

    vm.stopPrank();

    uint256[] memory recipients = new uint256[](2);
    uint256[] memory workerRewards = new uint256[](2);
    uint256[] memory stakerRewards = new uint256[](2);

    recipients[0] = workerIds[0];
    recipients[1] = workerIds[1];
    workerRewards[0] = amounts[0];
    workerRewards[1] = amounts[1];
    stakerRewards[0] = amounts[0] / 2;
    stakerRewards[1] = amounts[1] / 2;

    // Generate a proper proof using new helpers
    (bytes32[] memory proof, uint64 kIndex) = _proof(0, mmrNodes, 4);

    vm.expectEmit(true, true, true, true);
    emit BatchDistributed(fromBlock, toBlock, 0, recipients, workerRewards, stakerRewards);

    // Use updated function signature with proper kIndex and leafIndex
    rewardsDistribution.distributeBatch(
      [fromBlock, toBlock],
      kIndex,
      0, // leafIndex
      recipients,
      workerRewards,
      stakerRewards,
      proof
    );

    assertEq(rewardsDistribution.withdrawableRewardOf(recipients[0]), workerRewards[0]);
    assertEq(rewardsDistribution.withdrawableRewardOf(recipients[1]), workerRewards[1]);
  }
}

contract SQD is IERC20 {
  string public name = "SQD Token";
  string public symbol = "SQD";
  uint8 public decimals = 18;
  uint256 private _totalSupply;
  mapping(address => uint256) private _balances;
  mapping(address => mapping(address => uint256)) private _allowances;

  constructor() {
    // No parameters needed for the test version
  }

  function totalSupply() external view override returns (uint256) {
    return _totalSupply;
  }

  function balanceOf(address account) external view override returns (uint256) {
    return _balances[account];
  }

  function transfer(address to, uint256 amount) external override returns (bool) {
    address owner = msg.sender;
    _transfer(owner, to, amount);
    return true;
  }

  function allowance(address owner, address spender) external view override returns (uint256) {
    return _allowances[owner][spender];
  }

  function approve(address spender, uint256 amount) external override returns (bool) {
    address owner = msg.sender;
    _approve(owner, spender, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
    address spender = msg.sender;
    _spendAllowance(from, spender, amount);
    _transfer(from, to, amount);
    return true;
  }

  // Additional function to mint tokens for testing purposes
  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function _transfer(address from, address to, uint256 amount) internal {
    require(from != address(0), "ERC20: transfer from the zero address");
    require(to != address(0), "ERC20: transfer to the zero address");

    uint256 fromBalance = _balances[from];
    require(fromBalance >= amount, "ERC20: transfer amount exceeds balance");
    unchecked {
      _balances[from] = fromBalance - amount;
      _balances[to] += amount;
    }

    emit Transfer(from, to, amount);
  }

  function _mint(address account, uint256 amount) internal {
    require(account != address(0), "ERC20: mint to the zero address");

    _totalSupply += amount;
    unchecked {
      _balances[account] += amount;
    }
    emit Transfer(address(0), account, amount);
  }

  function _approve(address owner, address spender, uint256 amount) internal {
    require(owner != address(0), "ERC20: approve from the zero address");
    require(spender != address(0), "ERC20: approve to the zero address");

    _allowances[owner][spender] = amount;
    emit Approval(owner, spender, amount);
  }

  function _spendAllowance(address owner, address spender, uint256 amount) internal {
    uint256 currentAllowance = _allowances[owner][spender];
    if (currentAllowance != type(uint256).max) {
      require(currentAllowance >= amount, "ERC20: insufficient allowance");
      unchecked {
        _approve(owner, spender, currentAllowance - amount);
      }
    }
  }
}
