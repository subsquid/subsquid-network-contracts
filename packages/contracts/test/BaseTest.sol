// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "forge-std/Test.sol";
import "forge-std/Vm.sol";
import "../src/WorkerRegistration.sol";
import "../src/Staking.sol";
import "../src/NetworkController.sol";
import "../src/RewardTreasury.sol";
import "../src/Router.sol";
import "../src/tSQD.sol";
import "../src/RewardCalculation.sol";

contract MockRewardsDistribution is IRewardsDistribution {
  function claimable(address) external pure override returns (uint256) {
    return 69;
  }

  function claim(address) external pure override returns (uint256) {
    return 69;
  }
}

contract BaseTest is Test {
  SoftCap cap;

  function deployAll() internal returns (tSQD token, Router router) {
    router = Router(address(new TransparentUpgradeableProxy(address(new Router()), address(1234), "")));
    uint256[] memory minted = new uint256[](1);
    minted[0] = 1_337_000_000 ether;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    token = new tSQD(holders, minted, IL1CustomGateway(address(0)), IGatewayRouter2(address(0)));

    IWorkerRegistration workerRegistration = new WorkerRegistration(token, router);
    IStaking staking = new Staking(token, router);
    RewardTreasury treasury = new RewardTreasury(token);
    cap = new SoftCap(router);
    RewardCalculation rewards = new RewardCalculation(router, cap);
    address[] memory allowedTargets = new address[](3);
    allowedTargets[0] = address(workerRegistration);
    allowedTargets[1] = address(staking);
    allowedTargets[2] = address(treasury);
    INetworkController networkController = new NetworkController(5, 10 ether, allowedTargets);
    router.initialize(workerRegistration, staking, address(treasury), networkController, rewards);
  }

  function getCaller() internal returns (address) {
    (VmSafe.CallerMode mode, address prank,) = vm.readCallers();
    if (mode == VmSafe.CallerMode.Prank || mode == VmSafe.CallerMode.RecurrentPrank) {
      return prank;
    }
    return address(this);
  }

  function expectNotAdminRevert() internal {
    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, getCaller(), bytes32(0))
    );
  }

  function expectNotRoleRevert(bytes32 role) internal {
    vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, getCaller(), role));
  }
}
