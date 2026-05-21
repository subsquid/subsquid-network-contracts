// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../BaseTest.sol";
import "forge-std/console.sol";
import {DistributedRewardsDistribution} from "../../src/DistributedRewardsDistribution.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IRewardsDistribution} from "../../src/interfaces/IRewardsDistribution.sol";
import {Staking} from "../../src/Staking.sol";

contract DistributedRewardsDistributionFullFlowTest is BaseTest {
  DistributedRewardsDistribution rewards;
  SQD token;
  Router router;

  address admin = address(1);
  address distributor1 = address(2);
  address distributor2 = address(3);
  address user1 = address(101);
  address user2 = address(102);
  address user3 = address(201);
  address user4 = address(202);

  uint256 fromBlock = 100;
  uint256 toBlock = 200;

  function setUp() public {
    vm.startPrank(address(this));
    (token, router) = deployAll();
    rewards = new DistributedRewardsDistribution(router);
    rewards.grantRole(rewards.REWARDS_DISTRIBUTOR_ROLE(), distributor1);
    rewards.grantRole(rewards.REWARDS_DISTRIBUTOR_ROLE(), distributor2);
    rewards.grantRole(rewards.REWARDS_TREASURY_ROLE(), address(this));

    rewards.addDistributor(distributor1);
    rewards.addDistributor(distributor2);
    rewards.setApprovesRequired(1);

    Staking(address(router.staking())).grantRole(
      Staking(address(router.staking())).REWARDS_DISTRIBUTOR_ROLE(), address(rewards)
    );

    console.log("Admin balance before:", token.balanceOf(admin));
    console.log("Test contract balance:", token.balanceOf(address(this)));

    token.transfer(user1, 10e18);
    token.transfer(user2, 10e18);
    token.transfer(user3, 10e18);
    token.transfer(user4, 10e18);

    vm.stopPrank();
  }

  function createMerkleTree(uint256[] memory recipients, uint256[] memory workerRewards, uint256[] memory stakerRewards)
    internal
    pure
    returns (bytes32 root, bytes32[] memory leaves, bytes32[][] memory proofs)
  {
    require(
      recipients.length == workerRewards.length && workerRewards.length == stakerRewards.length,
      "Input arrays must be the same length"
    );

    leaves = new bytes32[](recipients.length);
    for (uint256 i = 0; i < recipients.length; i++) {
      uint256[] memory recipientArr = new uint256[](1);
      uint256[] memory workerRewardArr = new uint256[](1);
      uint256[] memory stakerRewardArr = new uint256[](1);

      recipientArr[0] = recipients[i];
      workerRewardArr[0] = workerRewards[i];
      stakerRewardArr[0] = stakerRewards[i];

      leaves[i] = keccak256(abi.encode(recipientArr, workerRewardArr, stakerRewardArr));
    }

    if (leaves.length == 2) {
      (bytes32 a, bytes32 b) = sortPair(leaves[0], leaves[1]);
      root = keccak256(abi.encodePacked(a, b));

      proofs = new bytes32[][](2);
      proofs[0] = new bytes32[](1);
      proofs[1] = new bytes32[](1);
      proofs[0][0] = leaves[1];
      proofs[1][0] = leaves[0];

      return (root, leaves, proofs);
    }

    root = leaves[0];
    proofs = new bytes32[][](leaves.length);

    return (root, leaves, proofs);
  }

  function sortPair(bytes32 a, bytes32 b) internal pure returns (bytes32, bytes32) {
    return a < b ? (a, b) : (b, a);
  }

  function testFullDistributionFlow() public {
    token.transfer(admin, 100 ether);

    vm.startPrank(admin);

    // Create two batches of rewards for a total of four users
    uint256[] memory recipients1 = new uint256[](2);
    uint256[] memory workerRewards1 = new uint256[](2);
    uint256[] memory stakerRewards1 = new uint256[](2);

    recipients1[0] = uint256(uint160(user1));
    recipients1[1] = uint256(uint160(user2));
    workerRewards1[0] = 1 ether;
    workerRewards1[1] = 2 ether;
    stakerRewards1[0] = 0.5 ether;
    stakerRewards1[1] = 1 ether;

    uint256[] memory recipients2 = new uint256[](2);
    uint256[] memory workerRewards2 = new uint256[](2);
    uint256[] memory stakerRewards2 = new uint256[](2);

    recipients2[0] = uint256(uint160(user3));
    recipients2[1] = uint256(uint160(user4));
    workerRewards2[0] = 3 ether;
    workerRewards2[1] = 4 ether;
    stakerRewards2[0] = 1.5 ether;
    stakerRewards2[1] = 2 ether;

    // Create the merkle tree
    bytes32 leaf1 = keccak256(abi.encode(recipients1, workerRewards1, stakerRewards1));
    bytes32 leaf2 = keccak256(abi.encode(recipients2, workerRewards2, stakerRewards2));

    bytes32[] memory leaves = new bytes32[](2);
    leaves[0] = leaf1;
    leaves[1] = leaf2;

    // Sort for OpenZeppelin's implementation
    (bytes32 a, bytes32 b) = sortPair(leaf1, leaf2);
    bytes32 root = keccak256(abi.encodePacked(a, b));

    // Create proofs
    bytes32[] memory proof1 = new bytes32[](1);
    bytes32[] memory proof2 = new bytes32[](1);
    proof1[0] = leaf2;
    proof2[0] = leaf1;

    uint256 totalRewards = 12 ether; // Sum of all rewards
    token.approve(address(rewards), totalRewards);
    token.transfer(address(rewards), totalRewards);

    vm.stopPrank();
    vm.roll(fromBlock + 100);

    vm.prank(distributor1);
    rewards.commitRoot([fromBlock, toBlock], root, 2, "ipfs://testcid");

    vm.prank(distributor1);
    rewards.distribute([fromBlock, toBlock], recipients1, workerRewards1, stakerRewards1, proof1);

    vm.prank(distributor2);
    rewards.distribute([fromBlock, toBlock], recipients2, workerRewards2, stakerRewards2, proof2);

    assertEq(rewards.lastBlockRewarded(), toBlock);

    assertEq(rewards.claimable(user1), 1.5 ether); // Worker + staker rewards
    assertEq(rewards.claimable(user2), 3 ether);
    assertEq(rewards.claimable(user3), 4.5 ether);
    assertEq(rewards.claimable(user4), 6 ether);

    uint256 balanceBefore = token.balanceOf(user1);
    vm.prank(user1);
    uint256 claimed = rewards.claim(user1);

    assertEq(claimed, 1.5 ether);
    assertEq(token.balanceOf(user1), balanceBefore + 1.5 ether);
    assertEq(rewards.claimable(user1), 0); // Should be zero after claiming
  }

  function testEdgeCaseInvalidProof() public {
    token.transfer(admin, 20 ether);

    vm.startPrank(admin);

    uint256[] memory recipients = new uint256[](2);
    uint256[] memory workerRewards = new uint256[](2);
    uint256[] memory stakerRewards = new uint256[](2);

    recipients[0] = uint256(uint160(user1));
    recipients[1] = uint256(uint160(user2));
    workerRewards[0] = 1 ether;
    workerRewards[1] = 2 ether;
    stakerRewards[0] = 0.5 ether;
    stakerRewards[1] = 1 ether;

    bytes32 leaf = keccak256(abi.encode(recipients, workerRewards, stakerRewards));
    bytes32 root = keccak256(abi.encodePacked(leaf, bytes32(0))); // Different root

    token.approve(address(rewards), 10 ether);
    token.transfer(address(rewards), 10 ether);

    vm.stopPrank();
    vm.roll(fromBlock + 100);

    vm.prank(distributor1);
    rewards.commitRoot([fromBlock, toBlock], root, 1, "ipfs://testcid");

    bytes32[] memory invalidProof = new bytes32[](1);
    invalidProof[0] = bytes32(uint256(1));

    vm.prank(distributor1);
    vm.expectRevert("Invalid merkle proof");
    rewards.distribute([fromBlock, toBlock], recipients, workerRewards, stakerRewards, invalidProof);
  }

  function testEdgeCaseDoubleDistribution() public {
    token.transfer(admin, 20 ether);

    vm.startPrank(admin);

    uint256[] memory recipients = new uint256[](1);
    uint256[] memory workerRewards = new uint256[](1);
    uint256[] memory stakerRewards = new uint256[](1);

    recipients[0] = uint256(uint160(user1));
    workerRewards[0] = 1 ether;
    stakerRewards[0] = 0.5 ether;

    bytes32 leaf = keccak256(abi.encode(recipients, workerRewards, stakerRewards));
    bytes32 root = leaf; // For a single leaf, the root is the leaf itself

    token.approve(address(rewards), 10 ether);
    token.transfer(address(rewards), 10 ether);

    vm.stopPrank();
    vm.roll(fromBlock + 100);

    vm.prank(distributor1);
    rewards.commitRoot([fromBlock, toBlock], root, 1, "ipfs://testcid");

    bytes32[] memory proof = new bytes32[](0);

    vm.prank(distributor1);
    rewards.distribute([fromBlock, toBlock], recipients, workerRewards, stakerRewards, proof);

    vm.prank(distributor1);
    vm.expectRevert("Rewards already distributed");
    rewards.distribute([fromBlock, toBlock], recipients, workerRewards, stakerRewards, proof);
  }

  function testEdgeCaseInsufficientFunds() public {
    token.transfer(admin, 20 ether);

    vm.startPrank(admin);

    uint256[] memory recipients = new uint256[](1);
    uint256[] memory workerRewards = new uint256[](1);
    uint256[] memory stakerRewards = new uint256[](1);

    recipients[0] = uint256(uint160(user1));
    workerRewards[0] = 1000 ether;
    stakerRewards[0] = 500 ether;

    bytes32 leaf = keccak256(abi.encode(recipients, workerRewards, stakerRewards));
    bytes32 root = leaf;

    token.approve(address(rewards), 10 ether);
    token.transfer(address(rewards), 10 ether);

    vm.stopPrank();
    vm.roll(fromBlock + 100);

    vm.prank(distributor1);
    rewards.commitRoot([fromBlock, toBlock], root, 1, "ipfs://testcid");

    bytes32[] memory proof = new bytes32[](0);

    vm.prank(distributor1);
    vm.expectRevert();
    rewards.distribute([fromBlock, toBlock], recipients, workerRewards, stakerRewards, proof);
  }
}
