// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {DistributedRewardsDistribution} from "../../src/DistributedRewardsDistribution.sol";
import {IWorkerRegistration, WorkerRegistration} from "../../src/WorkerRegistration.sol";
import {IStaking, Staking} from "../../src/Staking.sol";
import {INetworkController, NetworkController} from "../../src/NetworkController.sol";
import {IRewardCalculation, RewardCalculation} from "../../src/RewardCalculation.sol";
import {SoftCap} from "../../src/SoftCap.sol";
import {Router, IRouter} from "../../src/Router.sol";
import {SQD, IL1CustomGateway, IGatewayRouter2} from "../../src/SQD.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract DistributedRewardsDistributionTest is Test {
  function createMerkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
    require(leaves.length > 0, "No leaves");

    if (leaves.length == 1) {
      return leaves[0];
    }

    // First level nodes
    bytes32[] memory currentLevel = new bytes32[](leaves.length);
    for (uint256 i = 0; i < leaves.length; i++) {
      currentLevel[i] = leaves[i];
    }

    // Build tree bottom-up
    while (currentLevel.length > 1) {
      bytes32[] memory nextLevel = new bytes32[]((currentLevel.length + 1) / 2);

      for (uint256 i = 0; i < nextLevel.length; i++) {
        if (i * 2 + 1 < currentLevel.length) {
          // Get the lower of the two values and place it on the left
          bytes32 left = currentLevel[i * 2];
          bytes32 right = currentLevel[i * 2 + 1];

          // OpenZeppelin sorts the hashes
          if (left > right) {
            (left, right) = (right, left);
          }

          nextLevel[i] = keccak256(abi.encodePacked(left, right));
        } else {
          // If we're at the end with an odd number, just promote the node
          nextLevel[i] = currentLevel[i * 2];
        }
      }

      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  // Hard-code a 2-leaf proof for simplicity and reliability testing
  function createMerkleProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
    require(leaves.length == 2, "Only 2-leaf proofs supported");
    require(index < 2, "Index out of bounds");

    bytes32[] memory proof = new bytes32[](1);
    proof[0] = index == 0 ? leaves[1] : leaves[0];
    return proof;
  }

  function sortPair(bytes32 a, bytes32 b) internal pure returns (bytes32, bytes32) {
    return a < b ? (a, b) : (b, a);
  }

  DistributedRewardsDistribution rewards;
  Router router;
  Staking staking;
  WorkerRegistration workers;
  SQD sqd;

  address admin = address(1);
  address dist1 = address(2);
  address dist2 = address(3);
  address treasury = address(4);

  uint256 fromBlock = 100;
  uint256 toBlock = 200;

  function setUp() public {
    vm.startPrank(admin);

    // Setup mock contracts
    address[] memory initialHolders = new address[](1);
    initialHolders[0] = admin;

    uint256[] memory initialAmounts = new uint256[](1);
    initialAmounts[0] = 1337000000 * 10 ** 18;

    sqd = new SQD(initialHolders, initialAmounts, IL1CustomGateway(address(0)), IGatewayRouter2(address(0)));

    address[] memory allowedVestedTargets = new address[](0);
    NetworkController networkController = new NetworkController(
      100, // epochLength
      0, // firstEpochBlock
      0, // epochCheckpoint
      1000 * 10 ** 18, // bondAmount
      allowedVestedTargets
    );

    router = new Router();

    workers = new WorkerRegistration(IERC20(address(sqd)), IRouter(address(router)));

    staking = new Staking(IERC20(address(sqd)), IRouter(address(router)));

    SoftCap softCap = new SoftCap(IRouter(address(router)));

    RewardCalculation rewardCalculation = new RewardCalculation(IRouter(address(router)), softCap);

    router.initialize(
      IWorkerRegistration(address(workers)),
      IStaking(address(staking)),
      address(treasury),
      INetworkController(address(networkController)),
      IRewardCalculation(address(rewardCalculation))
    );

    rewards = new DistributedRewardsDistribution(router);
    rewards.grantRole(rewards.REWARDS_DISTRIBUTOR_ROLE(), dist1);
    rewards.grantRole(rewards.REWARDS_DISTRIBUTOR_ROLE(), dist2);
    rewards.grantRole(rewards.REWARDS_TREASURY_ROLE(), treasury);
    rewards.addDistributor(dist1);
    rewards.addDistributor(dist2);
    rewards.setApprovesRequired(1);

    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewards));

    vm.stopPrank();
  }

  function testSingleRootMultipleBatches() public {
    /* ------ build two batch leaves ------ */
    uint256[] memory rec1 = new uint256[](2);
    uint256[] memory wr1 = new uint256[](2);
    uint256[] memory sr1 = new uint256[](2);
    rec1[0] = 101;
    rec1[1] = 102;
    wr1[0] = 1e18;
    wr1[1] = 2e18;
    sr1[0] = 5e17;
    sr1[1] = 1e18;

    uint256[] memory rec2 = new uint256[](2);
    uint256[] memory wr2 = new uint256[](2);
    uint256[] memory sr2 = new uint256[](2);
    rec2[0] = 201;
    rec2[1] = 202;
    wr2[0] = 3e18;
    wr2[1] = 4e18;
    sr2[0] = 15e17;
    sr2[1] = 2e18;

    bytes32 leaf1 = keccak256(abi.encode(rec1, wr1, sr1));
    bytes32 leaf2 = keccak256(abi.encode(rec2, wr2, sr2));

    bytes32[] memory leaves = new bytes32[](2);
    leaves[0] = leaf1;
    leaves[1] = leaf2;

    bytes32 root = createMerkleRoot(leaves);

    console.log("Leaf 1:");
    console.logBytes32(leaf1);
    console.log("Leaf 2:");
    console.logBytes32(leaf2);
    console.log("Root:");
    console.logBytes32(root);

    (bytes32 a, bytes32 b) = sortPair(leaf1, leaf2);
    bytes32 manualRoot = keccak256(abi.encodePacked(a, b));
    console.log("Manual root:");
    console.logBytes32(manualRoot);

    root = manualRoot;

    bytes32[] memory manualProof1 = new bytes32[](1);
    bytes32[] memory manualProof2 = new bytes32[](1);
    manualProof1[0] = leaf2;
    manualProof2[0] = leaf1;

    bool verified1 = MerkleProof.verify(manualProof1, root, leaf1);
    bool verified2 = MerkleProof.verify(manualProof2, root, leaf2);

    console.log("Manual proof 1 verified:", verified1);
    console.log("Manual proof 2 verified:", verified2);

    require(verified1, "Manual proof 1 invalid");
    require(verified2, "Manual proof 2 invalid");

    vm.roll(256);
    vm.prank(dist2);
    rewards.commitRoot([fromBlock, toBlock], root, 2, "ipfs://test");

    vm.prank(dist1);
    rewards.distribute([fromBlock, toBlock], rec1, wr1, sr1, manualProof1);

    vm.prank(dist1);
    rewards.distribute([fromBlock, toBlock], rec2, wr2, sr2, manualProof2);

    assertEq(rewards.lastBlockRewarded(), toBlock);
  }

  // Test to check wrong Proof 
}
