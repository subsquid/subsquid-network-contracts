// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Script.sol";

import "../src/NetworkController.sol";
import "../src/Router.sol";

/// @dev Deploys a NetworkController that continues the epoch numbering and settings of the one
/// the Router points to, with a new lock period. The Router admin switches to it afterwards
/// with `router.setNetworkController(controller)`.
/// The initial admin is the script contract in the dry run and the broadcaster on chain, so no
/// recorded renounce call is valid in both phases. The script only grants the role to ADMIN;
/// the broadcaster renounces it by hand after the broadcast, see the logged cast command.
/// VESTED_TARGETS must list every allowed target: the mapping cannot be enumerated on-chain.
contract MigrateNetworkController is Script {
  function run() public {
    Router router = Router(vm.envAddress("ROUTER"));
    uint128 lockPeriod = uint128(vm.envUint("LOCK_PERIOD_BLOCKS"));
    address admin = vm.envAddress("ADMIN");
    address[] memory vestedTargets = vm.envAddress("VESTED_TARGETS", ",");
    NetworkController current = NetworkController(address(router.networkController()));

    vm.startBroadcast();
    NetworkController controller = deploy(current, lockPeriod, vestedTargets, admin, msg.sender);
    vm.stopBroadcast();

    console2.log("NetworkController:", address(controller));
    console2.log("After the router switch, renounce the initial admin role from the broadcaster:");
    console2.log(
      string.concat(
        "cast send ",
        vm.toString(address(controller)),
        ' "renounceRole(bytes32,address)" ',
        vm.toString(controller.DEFAULT_ADMIN_ROLE()),
        " <broadcaster>"
      )
    );
  }

  function deploy(
    NetworkController current,
    uint128 lockPeriod,
    address[] memory vestedTargets,
    address admin,
    address deployer
  ) public returns (NetworkController controller) {
    require(admin != address(0), "Admin cannot be zero");

    for (uint256 i = 0; i < vestedTargets.length; i++) {
      require(current.isAllowedVestedTarget(vestedTargets[i]), "Not a vested target of the current controller");
    }

    uint128 epochLength = current.workerEpochLength();
    uint128 firstEpochBlock = current.firstEpochBlock();
    // epochCheckpoint is internal. epochNumber() returns it as is until firstEpochBlock,
    // which setEpochLength() moves to the next boundary, and (block - first) / length + checkpoint + 1 after
    uint128 epochCheckpoint = current.epochNumber();
    if (block.number >= firstEpochBlock) {
      epochCheckpoint -= (uint128(block.number) - firstEpochBlock) / epochLength + 1;
    }

    controller =
      new NetworkController(epochLength, firstEpochBlock, epochCheckpoint, current.bondAmount(), vestedTargets);
    controller.setLockPeriod(lockPeriod);
    controller.setStakingDeadlock(current.stakingDeadlock());
    controller.setStoragePerWorkerInGb(current.storagePerWorkerInGb());
    controller.setTargetCapacity(current.targetCapacityGb());
    controller.setYearlyRewardCapCoefficient(current.yearlyRewardCapCoefficient());

    require(controller.epochNumber() == current.epochNumber(), "Epoch number mismatch");
    require(controller.nextEpoch() == current.nextEpoch(), "Next epoch mismatch");

    bytes32 adminRole = controller.DEFAULT_ADMIN_ROLE();
    if (admin != deployer) {
      controller.grantRole(adminRole, admin);
    }
  }
}
