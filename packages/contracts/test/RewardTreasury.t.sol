// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../src/RewardTreasury.sol";
import "../src/SQD.sol";
import "./BaseTest.sol";

contract RewardTreasuryTest is BaseTest {
  RewardTreasury treasury;
  SQD token;
  IRewardsDistribution distributor;

  event Claimed(address indexed by, address indexed receiver, uint256 amount);
  event WhitelistedDistributorSet(IRewardsDistribution indexed distributor, bool isWhitelisted);

  function setUp() public {
    (SQD _token, Router router) = deployAll();
    token = _token;
    treasury = RewardTreasury(router.rewardTreasury());
    token.transfer(address(treasury), 100);

    distributor = new MockRewardsDistribution();
    treasury.setWhitelistedDistributor(distributor, true);
  }

  function test_RevertsIf_claimForNotWhitelistedDistributor() public {
    vm.expectRevert("Distributor not whitelisted");
    treasury.claim(IRewardsDistribution(address(1)));
  }

  function test_ClaimTransfersAmountReturnedByDistributorToSender() public {
    uint256 addressBefore = token.balanceOf(address(this));
    treasury.claim(distributor);
    uint256 addressAfter = token.balanceOf(address(this));
    assertEq(addressAfter, addressBefore + 69);
  }

  function test_ClaimForTransfersAmountReturnedByDistributorToReceiver() public {
    treasury.claimFor(distributor, address(2));
    assertEq(token.balanceOf(address(2)), 69);
  }

  function test_ClaimEmitsEvent() public {
    vm.expectEmit(address(treasury));
    emit Claimed(address(this), address(this), 69);
    treasury.claim(distributor);
  }

  function test_ClaimForEmitsEvent() public {
    vm.expectEmit(address(treasury));
    emit Claimed(address(this), address(2), 69);
    treasury.claimFor(distributor, address(2));
  }

  function test_ClaimableReturnsAmountReturnedByDistributor() public {
    assertEq(treasury.claimable(distributor, address(1)), 69);
  }

  function test_SetWhitelistedDistributorSetsDistributor() public {
    treasury.setWhitelistedDistributor(IRewardsDistribution(address(3)), true);
    assertEq(treasury.isWhitelistedDistributor(IRewardsDistribution(address(3))), true);
  }

  function test_SetWhitelistedDistributorUnsetsDistributor() public {
    treasury.setWhitelistedDistributor(distributor, false);
    assertEq(treasury.isWhitelistedDistributor(distributor), false);
  }

  function test_SetWhitelistedDistributorEmitsEvent() public {
    vm.expectEmit(address(treasury));
    emit WhitelistedDistributorSet(distributor, true);
    treasury.setWhitelistedDistributor(distributor, true);
  }

  function test_RevertsIf_SetWhitelistedDistributorNotCalledByAdmin() public {
    hoax(address(2));
    expectNotAdminRevert();
    treasury.setWhitelistedDistributor(distributor, true);
  }
}
