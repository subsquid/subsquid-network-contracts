// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";

import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IGatewayRegistry.sol";
import "../interfaces/IRouter.sol";
import "../libs/Errors.sol";

/**
 * @title EqualStrategyV2
 * @dev UUPS-upgradeable equal CU distribution with zero-worker division guard.
 */
contract EqualStrategyV2 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IGatewayStrategy {
  IRouter public router;
  IGatewayRegistry public gatewayRegistry;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(IRouter _router, IGatewayRegistry _gatewayRegistry) external initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    router = _router;
    gatewayRegistry = _gatewayRegistry;
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256) external view returns (uint256) {
    uint256 workerCount = router.workerRegistration().getActiveWorkerCount();
    if (workerCount == 0) return 0;
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / workerCount;
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[48] private __gap;
}
