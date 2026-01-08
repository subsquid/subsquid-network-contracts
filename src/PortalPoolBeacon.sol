// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @title Portal Pool Beacon
/// @notice Beacon contract for upgrading all portal pool implementations at once
/// @dev All portal pools created by the factory point to this beacon for their implementation
contract PortalPoolBeacon is UpgradeableBeacon {
    /**
     * @dev initializes the beacon with implementation and owner.
     * @param implementation_ address of the initial pool implementation.
     * @param initialOwner address of the beacon owner (typically the factory).
     */
    constructor(address implementation_, address initialOwner) UpgradeableBeacon(implementation_, initialOwner) {}
}
