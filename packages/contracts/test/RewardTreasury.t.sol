// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.18;

import "../src/RewardTreasury.sol";
import "../src/testnet/tSQD.sol";
import "./BaseTest.sol";

contract MockRewardsDistribution is IRewardsDistribution {
  function claimable(address) external pure override returns (uint256) {
    return 69;
  }

  function claim(address) external pure override returns (uint256) {
    return 69;
  }
}

contract RewardTreasuryTest is BaseTest {
  RewardTreasury treasury;
  tSQD token;
  IRewardsDistribution distributor;

  event Claimed(address indexed by, address indexed receiver, uint256 amount);
  event WhitelistedDistributorSet(IRewardsDistribution indexed distributor, bool isWhitelisted);

  function setUp() public {
    (tSQD _token, Router router) = deployAll();
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
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000002 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    hoax(address(2));
    treasury.setWhitelistedDistributor(distributor, true);
  }
}
