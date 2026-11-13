// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {IPortalPool} from "../../src/interfaces/IPortalPool.sol";
import {IPortalRegistry} from "../../src/interfaces/IPortalRegistry.sol";

/// @notice Rehearsal of the PortalRegistry upgrade against live Arbitrum One state.
/// @dev Skipped unless ARBITRUM_RPC_URL is set. Run with:
///        ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc forge test --match-contract PortalRegistryUpgradeFork -vv
///      Optional FORK_BLOCK pins the block; the public RPC only keeps a few thousand recent blocks of state,
///      so leave it unset there. Nothing is broadcast: every admin call is a prank on the fork.
contract PortalRegistryUpgradeForkTest is Test {
    address constant REGISTRY = 0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850;
    address constant FACTORY = 0x18184740eBE24881355E33cec620C44E575F2C70;
    address constant POOL_SQD = 0x438c2a47e82cD445524Ce5651AE7E6c1Dd386D09; // SQD Revenue Pool
    address constant POOL_LAMBDA = 0x89cA93e09ec7355A1d6bd410Fe0bB4C9B24542DB; // Lambda x SQD
    address constant OPERATOR = 0x9FC9Fc4cFD0993630cd0f37f00647d301EdCD2a9;
    /// @dev Sole DEFAULT_ADMIN_ROLE holder, from replaying RoleGranted/RoleRevoked and hasRole on 2026-11-12
    address constant ADMIN = 0x5800eEB867D6c490051321239E15C3ac90e801C1;
    address constant SQD = 0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 constant NEW_MANA = 80;

    // fresh 38-byte Ed25519 identity multihash, not used by any live portal
    bytes constant TEST_PEER_ID = hex"002408011220f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";

    PortalRegistry registry = PortalRegistry(REGISTRY);
    bool forked;
    address staker = makeAddr("forkStaker");
    address portalManager = makeAddr("portalManager");

    struct Snapshot {
        bytes32[2] clusterHash;
        bytes32[11] lowSlots;
        uint256 registrySqd;
        uint256 minStake;
        uint256 clusterCount;
        address factory;
    }

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blockNumber = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        forked = true;
    }

    function _implementation() internal view returns (address) {
        return address(uint160(uint256(vm.load(REGISTRY, IMPL_SLOT))));
    }

    function _cid(address pool) internal view returns (bytes32) {
        return registry.getClusterIdByAddress(pool);
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        s.clusterHash[0] = keccak256(abi.encode(registry.getCluster(_cid(POOL_SQD))));
        s.clusterHash[1] = keccak256(abi.encode(registry.getCluster(_cid(POOL_LAMBDA))));
        for (uint256 i = 0; i < 11; ++i) {
            s.lowSlots[i] = vm.load(REGISTRY, bytes32(i));
        }
        s.registrySqd = IERC20(SQD).balanceOf(REGISTRY);
        s.minStake = registry.minStake();
        s.clusterCount = registry.clusterCount();
        s.factory = registry.factory();
    }

    function _assertSame(Snapshot memory a, Snapshot memory b, string memory when) internal pure {
        assertEq(a.clusterHash[0], b.clusterHash[0], string.concat(when, ": SQD Revenue Pool cluster"));
        assertEq(a.clusterHash[1], b.clusterHash[1], string.concat(when, ": Lambda cluster"));
        for (uint256 i = 0; i < 11; ++i) {
            if (i == 7) continue; // mana, changed on purpose
            assertEq(a.lowSlots[i], b.lowSlots[i], string.concat(when, ": low slot"));
        }
        assertEq(a.registrySqd, b.registrySqd, string.concat(when, ": registry SQD balance"));
        assertEq(a.minStake, b.minStake, string.concat(when, ": minStake"));
        assertEq(a.clusterCount, b.clusterCount, string.concat(when, ": clusterCount"));
        assertEq(a.factory, b.factory, string.concat(when, ": factory"));
    }

    function _expectedCUs(address pool, uint256 mana) internal view returns (uint256) {
        IPortalRegistry.Cluster memory c = registry.getCluster(_cid(pool));
        uint256 capacity = IPortalPool(pool).getPoolInfo().capacity;
        uint256 effective = c.totalStaked > capacity ? capacity : c.totalStaked;
        return effective * mana / (10000 * 1e18);
    }

    function _logCluster(string memory name, address pool) internal view {
        IPortalRegistry.Cluster memory c = registry.getCluster(_cid(pool));
        console2.log(name);
        console2.log("  operator", c.operator);
        console2.log("  totalStaked", c.totalStaked);
        console2.log("  active", c.active);
        console2.log("  portals", c.portals.length);
        console2.log("  metadata", c.metadata);
        console2.log("  capacity", IPortalPool(pool).getPoolInfo().capacity);
        console2.log("  CUs", registry.getComputationUnits(_cid(pool)));
    }

    /// deposit -> requestExit -> wait for the queue -> withdrawExit; returns the reward claimed (0 if none)
    function _stakerRoundTrip(address pool, uint256 amount, bool claim) internal returns (uint256 claimed) {
        bytes32 cid = _cid(pool);
        uint256 clusterStakeBefore = registry.getCluster(cid).totalStaked;
        uint256 registrySqdBefore = IERC20(SQD).balanceOf(REGISTRY);

        if (PortalPoolImplementation(pool).whitelistEnabled() && !IPortalPool(pool).isWhitelisted(staker)) {
            address[] memory list = new address[](1);
            list[0] = staker;
            vm.prank(OPERATOR);
            IPortalPool(pool).addToWhitelist(list);
        }

        deal(SQD, staker, amount);
        vm.startPrank(staker);
        IERC20(SQD).approve(pool, amount);
        IPortalPool(pool).deposit(amount);
        vm.stopPrank();
        assertEq(registry.getCluster(cid).totalStaked, clusterStakeBefore + amount, "deposit staked in registry");
        assertEq(IERC20(SQD).balanceOf(REGISTRY), registrySqdBefore + amount, "registry received SQD");

        vm.warp(block.timestamp + 6 hours);

        vm.prank(staker);
        uint256 ticket = IPortalPool(pool).requestExit(amount);
        (,,,, uint256 unlockAt) = IPortalPool(pool).getQueueStatusWithTimestamp(staker, ticket);
        console2.log("  exit queue wait (s)", unlockAt - block.timestamp);
        vm.warp(unlockAt + 1);

        vm.prank(staker);
        IPortalPool(pool).withdrawExit(ticket);
        assertEq(IERC20(SQD).balanceOf(staker), amount, "staker got SQD back");
        assertEq(registry.getCluster(cid).totalStaked, clusterStakeBefore, "registry stake restored");
        assertEq(IERC20(SQD).balanceOf(REGISTRY), registrySqdBefore, "registry SQD restored");

        if (claim) {
            address rewardToken = IPortalPool(pool).getRewardToken();
            uint256 before = IERC20(rewardToken).balanceOf(staker);
            vm.prank(staker);
            IPortalPool(pool).claimRewards();
            claimed = IERC20(rewardToken).balanceOf(staker) - before;
        }
        deal(SQD, staker, 0);
    }

    function test_fork_upgradeRehearsal() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("fork block", block.number, "timestamp", block.timestamp);

        // 0. preconditions
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), ADMIN), "admin holds DEFAULT_ADMIN_ROLE");
        assertEq(registry.getCluster(_cid(POOL_SQD)).operator, OPERATOR);
        assertEq(registry.getCluster(_cid(POOL_LAMBDA)).operator, OPERATOR);
        address oldImpl = _implementation();
        console2.log("old implementation", oldImpl);
        console2.log("mana before", registry.mana());
        _logCluster("SQD Revenue Pool (before)", POOL_SQD);
        _logCluster("Lambda x SQD (before)", POOL_LAMBDA);
        Snapshot memory before = _snapshot();

        // 1. deploy the new implementation and upgrade as the live admin
        PortalRegistry newImpl = new PortalRegistry();
        console2.log("new implementation", address(newImpl));
        vm.prank(ADMIN);
        UUPSUpgradeable(REGISTRY).upgradeToAndCall(address(newImpl), "");
        assertEq(_implementation(), address(newImpl), "proxy points at new implementation");
        _assertSame(before, _snapshot(), "after upgrade");
        assertEq(registry.mana(), 1000);

        // 2. setMana(80): CUs = min(totalStaked, capacity) * 80 / 1e4 (in whole SQD)
        vm.prank(ADMIN);
        registry.setMana(NEW_MANA);
        assertEq(registry.mana(), NEW_MANA);
        assertEq(registry.getComputationUnits(_cid(POOL_SQD)), _expectedCUs(POOL_SQD, NEW_MANA));
        assertEq(registry.getComputationUnits(_cid(POOL_LAMBDA)), _expectedCUs(POOL_LAMBDA, NEW_MANA));
        _assertSame(before, _snapshot(), "after setMana");
        _logCluster("SQD Revenue Pool (mana 80)", POOL_SQD);
        _logCluster("Lambda x SQD (mana 80)", POOL_LAMBDA);

        // 3. a real staker flow on the pool with room left, with a top-up so rewards accrue
        address pool = POOL_SQD;
        {
            address rewardToken = IPortalPool(pool).getRewardToken();
            uint256 topUp = 1_000 * 10 ** 6;
            deal(rewardToken, OPERATOR, topUp);
            vm.startPrank(OPERATOR);
            IERC20(rewardToken).approve(pool, topUp);
            IPortalPool(pool).topUpRewards(topUp);
            vm.stopPrank();
        }
        console2.log("staker round trip (new implementation)");
        uint256 claimed = _stakerRoundTrip(pool, 10_000 ether, true);
        console2.log("  rewards claimed (reward token units)", claimed);
        assertGt(claimed, 0, "staker earned and claimed rewards");
        _assertSame(before, _snapshot(), "after staker round trip");

        // 4. grant PORTAL_MANAGER_ROLE and bind a fresh peer ID to a live cluster
        bytes32 role = registry.PORTAL_MANAGER_ROLE();
        vm.prank(ADMIN);
        registry.grantRole(role, portalManager);
        bytes32 cid = _cid(pool);
        vm.prank(portalManager);
        registry.addPortal(cid, TEST_PEER_ID, "{\"name\":\"rehearsal\"}");
        assertEq(registry.getClusterIdByPeerId(TEST_PEER_ID), cid, "peer resolves to the cluster");
        uint256 cus = registry.getComputationUnits(registry.getClusterIdByPeerId(TEST_PEER_ID));
        assertEq(cus, _expectedCUs(pool, NEW_MANA), "CUs = capped stake * 80 / 1e4");
        console2.log("portal CUs via peer lookup", cus);
        (, IPortalRegistry.Cluster[] memory active, uint256 totalActive) = registry.getActiveClusters(0, 5);
        assertEq(totalActive, 2);
        bool seen;
        for (uint256 i = 0; i < active.length; ++i) {
            if (active[i].clusterAddress == pool) seen = active[i].portals.length == 1;
        }
        assertTrue(seen, "getActiveClusters returns the new portal");

        // 5. the operator can no longer bind peer IDs
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, OPERATOR, role)
        );
        registry.addPortal(cid, hex"002408011220abababababababababababababababababababababababababababababababab", "");

        // 6. the manager removes the portal; the peer ID is released
        vm.prank(portalManager);
        registry.forceRemovePortal(TEST_PEER_ID);
        assertEq(registry.getClusterIdByPeerId(TEST_PEER_ID), bytes32(0), "peer released");
        _assertSame(before, _snapshot(), "after portal add/remove");

        // 7. roll back to the previous implementation
        vm.prank(ADMIN);
        UUPSUpgradeable(REGISTRY).upgradeToAndCall(oldImpl, "");
        assertEq(_implementation(), oldImpl, "proxy points at old implementation again");
        _assertSame(before, _snapshot(), "after rollback");
        assertEq(registry.mana(), NEW_MANA, "mana is storage: it survives the rollback");
        assertTrue(registry.hasRole(role, portalManager), "role grant survives the rollback (revoke it)");
        console2.log("staker round trip (rolled back)");
        _stakerRoundTrip(pool, 10_000 ether, false);
        _assertSame(before, _snapshot(), "after rolled-back staker round trip");

        // the old code lets operators register portals again
        vm.prank(OPERATOR);
        registry.addPortal(cid, TEST_PEER_ID, "");
        assertEq(registry.getClusterIdByPeerId(TEST_PEER_ID), cid);
    }
}
