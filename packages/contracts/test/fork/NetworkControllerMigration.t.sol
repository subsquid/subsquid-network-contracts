// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../../script/MigrateNetworkController.s.sol";
import "../../src/Staking.sol";
import "../../src/WorkerRegistration.sol";

/// @dev Rehearses MigrateNetworkController against Arbitrum One state.
/// Runs only when ARBITRUM_RPC_URL is set; FORK_BLOCK pins the L2 block, the latest one is used otherwise.
contract NetworkControllerMigrationForkTest is Test {
  Router constant router = Router(0x67F56D27dab93eEb07f6372274aCa277F49dA941);
  uint128 constant LOCK_PERIOD = 1_095_000;

  // Every address in the current controller's AllowedVestedTargetUpdated logs; re-scan them before a migration
  address[] knownTargets = [
    0x36E2B147Db67E76aB67a4d07C293670EbeFcAE4E, // WorkerRegistration
    0x237Abf43bc51fd5c50d0D598A1A4c26E56a8A2A0, // RewardTreasury
    0xB31a0D39D2C69Ed4B28d96E12cbf52C5f9Ac9a51, // Staking
    0x8A90A1cE5fa8Cf71De9e6f76B7d3c0B72feB8c4b, // GatewayRegistry
    0x4EFab28E320eF16907930a06e2a5AaADb7425B48,
    0x1c77ad535552E7428630bCDF5B10B1E992F9f16c // allowed, then disallowed
  ];

  address admin = makeAddr("admin");
  MigrateNetworkController script;
  NetworkController current;
  NetworkController migrated;
  WorkerRegistration workerRegistration;
  Staking staking;

  function setUp() public {
    string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
    if (bytes(rpc).length == 0) {
      vm.skip(true);
      return;
    }

    uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
    if (forkBlock == 0) {
      vm.createSelectFork(rpc);
    } else {
      vm.createSelectFork(rpc, forkBlock);
    }

    current = NetworkController(address(router.networkController()));
    workerRegistration = WorkerRegistration(address(router.workerRegistration()));
    staking = Staking(address(router.staking()));

    script = new MigrateNetworkController();
    migrated = script.deploy(current, LOCK_PERIOD, allowedTargets(), admin, address(script));
  }

  function allowedTargets() internal view returns (address[] memory targets) {
    uint256 count = 0;
    for (uint256 i = 0; i < knownTargets.length; i++) {
      if (current.isAllowedVestedTarget(knownTargets[i])) count++;
    }

    targets = new address[](count);
    uint256 j = 0;
    for (uint256 i = 0; i < knownTargets.length; i++) {
      if (current.isAllowedVestedTarget(knownTargets[i])) targets[j++] = knownTargets[i];
    }
  }

  // Stands in for the admin's router.setNetworkController call. stdstore cannot see through
  // the Router proxy, so the slot comes from `forge inspect Router storageLayout`.
  function switchRouter() internal {
    vm.store(address(router), bytes32(uint256(4)), bytes32(uint256(uint160(address(migrated)))));
    assertEq(address(router.networkController()), address(migrated));
  }

  function registerWorker(bytes memory peerId) internal returns (uint256 workerId) {
    address operator = makeAddr(string(peerId));
    IERC20 sqd = workerRegistration.SQD();
    uint256 bond = workerRegistration.bondAmount();
    deal(address(sqd), operator, bond);

    vm.startPrank(operator);
    sqd.approve(address(workerRegistration), bond);
    workerRegistration.register(peerId);
    vm.stopPrank();

    vm.roll(workerRegistration.nextEpoch());
    return workerRegistration.workerIds(peerId);
  }

  function test_ContinuesEpochNumbering() public {
    uint256[6] memory offsets = [uint256(0), 1, 99, 100, 7_000, LOCK_PERIOD];
    uint256 start = block.number;
    for (uint256 i = 0; i < offsets.length; i++) {
      vm.roll(start + offsets[i]);
      assertEq(migrated.epochNumber(), current.epochNumber());
      assertEq(migrated.nextEpoch(), current.nextEpoch());
    }
  }

  function test_CopiesSettings() public {
    assertEq(migrated.lockPeriod(), LOCK_PERIOD);
    assertEq(migrated.workerEpochLength(), current.workerEpochLength());
    assertEq(migrated.firstEpochBlock(), current.firstEpochBlock());
    assertEq(migrated.bondAmount(), current.bondAmount());
    assertEq(migrated.stakingDeadlock(), current.stakingDeadlock());
    assertEq(migrated.storagePerWorkerInGb(), current.storagePerWorkerInGb());
    assertEq(migrated.targetCapacityGb(), current.targetCapacityGb());
    assertEq(migrated.yearlyRewardCapCoefficient(), current.yearlyRewardCapCoefficient());
    for (uint256 i = 0; i < knownTargets.length; i++) {
      assertEq(migrated.isAllowedVestedTarget(knownTargets[i]), current.isAllowedVestedTarget(knownTargets[i]));
    }
  }

  function test_HandsAdminRoleOver() public {
    bytes32 adminRole = migrated.DEFAULT_ADMIN_ROLE();
    assertTrue(migrated.hasRole(adminRole, admin));
    assertFalse(migrated.hasRole(adminRole, address(script)));
  }

  function test_RevertsIf_TargetNotAllowedByCurrentController() public {
    address[] memory targets = new address[](1);
    targets[0] = makeAddr("stranger");
    vm.expectRevert("Not a vested target of the current controller");
    script.deploy(current, LOCK_PERIOD, targets, admin, address(script));
  }

  function test_RouterConsumersReadNewLockPeriod() public {
    switchRouter();
    assertEq(workerRegistration.lockPeriod(), LOCK_PERIOD);
    assertEq(staking.lockLengthBlocks(), LOCK_PERIOD * staking.epochsLockedAfterStake());
  }

  function test_LocksWorkerBondForNewPeriod() public {
    switchRouter();
    bytes memory peerId = "migration-fork-test-worker";
    registerWorker(peerId);
    address operator = makeAddr(string(peerId));
    uint256 unlockBlock = workerRegistration.nextEpoch() + LOCK_PERIOD;

    vm.startPrank(operator);
    workerRegistration.deregister(peerId);

    vm.roll(unlockBlock - 1);
    vm.expectRevert("Worker is locked");
    workerRegistration.withdraw(peerId);

    vm.roll(unlockBlock);
    workerRegistration.withdraw(peerId);
    vm.stopPrank();

    assertEq(workerRegistration.SQD().balanceOf(operator), workerRegistration.bondAmount());
  }

  function test_LocksDelegationForNewPeriod() public {
    switchRouter();
    uint256 workerId = registerWorker("migration-fork-test-delegated-worker");
    address delegator = makeAddr("delegator");
    IERC20 sqd = staking.token();
    uint256 amount = 1_000 ether;
    deal(address(sqd), delegator, amount);
    uint256 unlockBlock = migrated.nextEpoch() + LOCK_PERIOD * staking.epochsLockedAfterStake();

    vm.startPrank(delegator);
    sqd.approve(address(staking), amount);
    staking.deposit(workerId, amount);
    (, uint256 whenCanWithdraw) = staking.getDeposit(delegator, workerId);
    assertEq(whenCanWithdraw, unlockBlock);

    vm.roll(unlockBlock - 1);
    vm.expectRevert("Too early to withdraw");
    staking.withdraw(workerId, amount);

    vm.roll(unlockBlock);
    staking.withdraw(workerId, amount);
    vm.stopPrank();

    assertEq(sqd.balanceOf(delegator), amount);
  }
}
