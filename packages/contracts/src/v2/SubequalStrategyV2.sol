// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";

import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IGatewayRegistry.sol";
import "../interfaces/IRouter.sol";

/**
 * @title SubequalStrategyV2
 * @dev UUPS-upgradeable subequal CU distribution.
 *      Fixes duplicate worker bug: checks isWorkerSupported before inc/dec workerCount.
 */
contract SubequalStrategyV2 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IGatewayStrategy {
  IRouter public router;
  IGatewayRegistry public gatewayRegistry;

  mapping(address gatewayOperator => mapping(uint256 workerId => bool)) public isWorkerSupported;
  mapping(address gatewayOperator => uint256) public workerCount;

  event WorkerSupported(address gatewayOperator, uint256 workerId);
  event WorkerUnsupported(address gatewayOperator, uint256 workerId);

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

  /// @dev Fixed: only increments workerCount for workers not already supported
  function supportWorkers(uint256[] calldata workerIds) external {
    uint256 added = 0;
    for (uint256 i = 0; i < workerIds.length; i++) {
      if (!isWorkerSupported[msg.sender][workerIds[i]]) {
        isWorkerSupported[msg.sender][workerIds[i]] = true;
        added++;
        emit WorkerSupported(msg.sender, workerIds[i]);
      }
    }
    workerCount[msg.sender] += added;
  }

  /// @dev Fixed: only decrements workerCount for workers actually supported
  function unsupportWorkers(uint256[] calldata workerIds) external {
    uint256 removed = 0;
    for (uint256 i = 0; i < workerIds.length; i++) {
      if (isWorkerSupported[msg.sender][workerIds[i]]) {
        isWorkerSupported[msg.sender][workerIds[i]] = false;
        removed++;
        emit WorkerUnsupported(msg.sender, workerIds[i]);
      }
    }
    workerCount[msg.sender] -= removed;
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256 workerId) external view returns (uint256) {
    address operator = gatewayRegistry.getGateway(gatewayId).operator;
    if (!isWorkerSupported[operator][workerId]) {
      return 0;
    }
    uint256 count = workerCount[operator];
    if (count == 0) return 0;
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / count;
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[46] private __gap;
}
