// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PortalPoolBeacon is UpgradeableBeacon {
    constructor(address implementation_, address initialOwner) UpgradeableBeacon(implementation_, initialOwner) {}
}


