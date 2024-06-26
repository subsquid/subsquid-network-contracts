// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./BaseTest.sol";
import "../src/SoftCap.sol";
import {LinearToSqrtCap} from "../src/LinearToSqrtCap.sol";

contract LinearToSqrtCapTest is BaseTest {
  Router router;
  LinearToSqrtCap sqrtCap;

  function setUp() public {
    (, router) = deployAll();
    sqrtCap = new LinearToSqrtCap(router);
  }

  function test_CapedStakeLinear() public {
    assertCap(0, 0);
    assertCap(1000 ether, 1000 ether);
    assertCap(20000 ether, 20000 ether);
  }

  function test_CapedStakeSqrt() public {
    assertCap(20000 ether + 1, 20000 ether);
    assertCap(20000 ether + 3, 20000 ether + 1);
    assertCap(20001 ether, 20000499993750156245117);
    assertCap(30000 ether, 24494897427831780981972);
    assertCap(1_000_000 ether, 141421356237309504880168); // ~140k
  }

  function assertCap(uint256 mockStake, uint256 expected) internal {
    vm.mockCall(address(router.staking()), abi.encodeWithSelector(IStaking.delegated.selector), abi.encode(mockStake));
    assertEq(sqrtCap.capedStake(0), expected);
  }
}
