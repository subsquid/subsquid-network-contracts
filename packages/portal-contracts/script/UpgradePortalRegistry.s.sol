// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";

/// @notice Deploys the PortalRegistry 1.3.0 implementation and prints the admin calls that activate it.
/// @dev The admin is an MPC wallet, the admin vault. Each admin call is printed as a contract call for it
///      (chain, to, value 0, calldata) in the order to sign it, and simulated on the local fork; nothing
///      here sends an admin call. PORTAL_MANAGER_ROLE goes to the admin vault unless PORTAL_MANAGER overrides it.
///      Dry run (no key, nothing sent):
///        forge script script/UpgradePortalRegistry.s.sol --rpc-url https://arb1.arbitrum.io/rpc
///      Deploying the implementation is the only broadcastable step (`--broadcast` with a deployer account);
///      it needs no role.
contract UpgradePortalRegistry is Script {
    address public constant REGISTRY = 0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850;
    /// @dev Sole DEFAULT_ADMIN_ROLE holder on 2026-11-12, the admin vault (an MPC wallet); the script stops if that changed
    address public constant EXPECTED_ADMIN = 0x5800eEB867D6c490051321239E15C3ac90e801C1;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 public constant NEW_MANA = 80;

    function run() external {
        require(block.chainid == 42161, "Arbitrum One only");
        PortalRegistry registry = PortalRegistry(REGISTRY);
        require(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), EXPECTED_ADMIN), "admin changed: re-verify roles");
        address currentImpl = address(uint160(uint256(vm.load(REGISTRY, IMPL_SLOT))));
        address manager = vm.envOr("PORTAL_MANAGER", EXPECTED_ADMIN);
        require(manager != address(0), "PORTAL_MANAGER is zero");

        vm.startBroadcast();
        PortalRegistry newImpl = new PortalRegistry();
        vm.stopBroadcast();
        require(newImpl.proxiableUUID() == IMPL_SLOT, "not UUPS");

        bytes32 role = newImpl.PORTAL_MANAGER_ROLE();
        bytes memory upgradeCall = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(newImpl), ""));
        bytes memory manaCall = abi.encodeCall(PortalRegistry.setMana, (NEW_MANA));
        bytes memory grantCall = abi.encodeWithSignature("grantRole(bytes32,address)", role, manager);
        bytes memory rollbackCall = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (currentImpl, ""));
        bytes memory revokeCall = abi.encodeWithSignature("revokeRole(bytes32,address)", role, manager);

        console2.log("=== PortalRegistry upgrade 1.2.0 -> 1.3.0 ===");
        console2.log("registry proxy        ", REGISTRY);
        console2.log("current implementation", currentImpl);
        console2.log("new implementation    ", address(newImpl));
        console2.log("admin vault           ", EXPECTED_ADMIN);
        console2.log("PORTAL_MANAGER_ROLE   ", vm.toString(role));
        console2.log("portal manager        ", manager, manager == EXPECTED_ADMIN ? "(the admin vault)" : "(override)");
        console2.log("");
        console2.log("Sign from the admin vault, one contract call each, in this order:");
        _printCall("Step 1", "upgradeToAndCall(new implementation, 0x)", upgradeCall);
        _printCall("Step 2", "setMana(80)", manaCall);
        _printCall("Step 3", "grantRole(PORTAL_MANAGER_ROLE, portal manager)", grantCall);
        console2.log("");
        console2.log("Rollback, from the same vault, in this order:");
        _printCall("Rollback 1", "upgradeToAndCall(current implementation, 0x)", rollbackCall);
        _printCall("Rollback 2", "revokeRole(PORTAL_MANAGER_ROLE, portal manager)", revokeCall);

        // Simulate the printed calldata as the admin on the local fork (never broadcast)
        uint256 cuBefore = registry.getComputationUnits(registry.allClusterIds(0));
        _simulate(upgradeCall);
        require(address(uint160(uint256(vm.load(REGISTRY, IMPL_SLOT)))) == address(newImpl), "upgrade failed");
        _simulate(manaCall);
        require(registry.mana() == NEW_MANA, "mana not set");
        _simulate(grantCall);
        require(registry.hasRole(role, manager), "role not granted");
        console2.log("");
        console2.log(
            "simulation ok; cluster 0 CUs before/after:",
            cuBefore,
            registry.getComputationUnits(registry.allClusterIds(0))
        );
    }

    function _printCall(string memory step, string memory what, bytes memory data) internal pure {
        console2.log(string.concat(step, ": ", what));
        console2.log("  chain:    Arbitrum One (42161)");
        console2.log("  to:      ", REGISTRY);
        console2.log("  value:    0");
        console2.log(string.concat("  calldata: ", vm.toString(data)));
    }

    function _simulate(bytes memory data) internal {
        vm.prank(EXPECTED_ADMIN);
        (bool ok, bytes memory ret) = REGISTRY.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
