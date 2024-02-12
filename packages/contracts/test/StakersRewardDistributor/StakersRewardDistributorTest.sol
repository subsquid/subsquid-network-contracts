// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/Staking.sol";
import "../../src/tSQD.sol";
import "../BaseTest.sol";

contract StakingHelper is Staking {
  constructor(IERC20 token, IRouter router) Staking(token, router) {}

  function distribute(uint256 worker, uint256 amount) external {
    lastEpochRewarded = router.networkController().epochNumber();
    _distribute(worker, amount);
  }
}

contract StakersRewardDistributionTest is BaseTest {
  uint256[] workers = [1234];
  StakingHelper staking;
  IERC20 token;
  NetworkController network;

  function setUp() public {
    (tSQD _token, Router router) = deployAll();
    token = _token;
    network = NetworkController(address(router.networkController()));
    network.setEpochLength(2);
    staking = new StakingHelper(token, router);
    router.setStaking(staking);
    token.transfer(address(1), token.totalSupply() / 2);
    token.approve(address(staking), type(uint256).max);
    hoax(address(1));
    token.approve(address(staking), type(uint256).max);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(this));
    vm.mockCall(
      address(router.workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.isWorkerActive.selector),
      abi.encode(true)
    );
  }

  function assertPairClaimable(uint256 rewardA, uint256 rewardB) internal {
    assertEq(staking.claimable(address(this)), rewardA);
    assertEq(staking.claimable(address(1)), rewardB);
  }
}
