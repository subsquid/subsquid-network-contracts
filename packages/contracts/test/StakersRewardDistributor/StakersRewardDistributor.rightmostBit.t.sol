// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionLBTest is StakersRewardDistributionTest {
  function test_LeftmostBit() public {
    assertEq(rewards.leftmostBitPosition(1), 0);
    assertEq(rewards.leftmostBitPosition(2), 1);
    assertEq(rewards.leftmostBitPosition(0x10000), 16);
  }

  BitMaps.BitMap bitmap;

  using BitMaps for BitMaps.BitMap;

  function test_LeftmostBitWithOZBitmap() public {
    bitmap.set(0);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 0);

    bitmap.set(5);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 5);

    bitmap.set(100);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 100);

    bitmap.set(127);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 127);

    bitmap.set(128);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 128);

    bitmap.set(255);
    assertEq(rewards.leftmostBitPosition(bitmap._data[0]), 255);
  }

  function test_FindPreviousBitInBitmapInSameBlock() public {
    bitmap.set(257);
    bitmap.set(400);
    bitmap.set(420);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 399), 257);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 400), 400);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 401), 400);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 405), 400);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 420), 420);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 425), 420);
  }

  function test_FindPreviousBitInBitmapInDifferentBlock() public {
    bitmap.set(111);
    bitmap.set(400);
    bitmap.set(420);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 399), 111);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 800), 420);
    assertEq(StakersRewardDistributor._findPreviousBitInBitmap(bitmap, 2500), 420);
  }
}
