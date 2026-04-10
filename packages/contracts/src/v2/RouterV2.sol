// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import "../interfaces/IRouter.sol";

/**
 * @title RouterV2
 * @dev UUPS-upgradeable contract that holds addresses of crucial subsquid contracts.
 *      Migrated from TransparentProxy to UUPS pattern with __gap for future storage safety.
 */
contract RouterV2 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IRouter {
  IWorkerRegistration public workerRegistration;
  IStaking public staking;
  address public rewardTreasury;
  INetworkController public networkController;
  IRewardCalculation public rewardCalculation;

  event WorkerRegistrationSet(IWorkerRegistration workerRegistration);
  event StakingSet(IStaking staking);
  event RewardTreasurySet(address rewardTreasury);
  event NetworkControllerSet(INetworkController networkController);
  event RewardCalculationSet(IRewardCalculation rewardCalculation);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    IWorkerRegistration _workerRegistration,
    IStaking _staking,
    address _rewardTreasury,
    INetworkController _networkController,
    IRewardCalculation _rewardCalculation
  ) external initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

    workerRegistration = _workerRegistration;
    staking = _staking;
    rewardTreasury = _rewardTreasury;
    networkController = _networkController;
    rewardCalculation = _rewardCalculation;
  }

  function setWorkerRegistration(IWorkerRegistration _workerRegistration) external onlyRole(DEFAULT_ADMIN_ROLE) {
    workerRegistration = _workerRegistration;
    emit WorkerRegistrationSet(_workerRegistration);
  }

  function setStaking(IStaking _staking) external onlyRole(DEFAULT_ADMIN_ROLE) {
    staking = _staking;
    emit StakingSet(_staking);
  }

  function setRewardTreasury(address _rewardTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
    rewardTreasury = _rewardTreasury;
    emit RewardTreasurySet(_rewardTreasury);
  }

  function setNetworkController(INetworkController _networkController) external onlyRole(DEFAULT_ADMIN_ROLE) {
    networkController = _networkController;
    emit NetworkControllerSet(_networkController);
  }

  function setRewardCalculation(IRewardCalculation _rewardCalculation) external onlyRole(DEFAULT_ADMIN_ROLE) {
    rewardCalculation = _rewardCalculation;
    emit RewardCalculationSet(_rewardCalculation);
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[45] private __gap;
}
