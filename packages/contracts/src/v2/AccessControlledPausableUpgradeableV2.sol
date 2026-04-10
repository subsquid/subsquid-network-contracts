// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {PausableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title AccessControlledPausableUpgradeableV2
 * @dev Base contract for all UUPS-upgradeable V2 contracts.
 *      Provides role-based access control, pausability, and upgrade authorization.
 */
abstract contract AccessControlledPausableUpgradeableV2 is
  PausableUpgradeable,
  AccessControlUpgradeable,
  UUPSUpgradeable
{
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function __AccessControlledPausableUpgradeableV2_init() internal onlyInitializing {
    __Pausable_init();
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(PAUSER_ROLE, msg.sender);
  }

  function pause() public virtual onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() public virtual onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[50] private __gap;
}
