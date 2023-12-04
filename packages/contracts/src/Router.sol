// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IRouter.sol";

contract Router is Initializable, AccessControl, IRouter {
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

  function initialize(
    IWorkerRegistration _workerRegistration,
    IStaking _staking,
    address _rewardTreasury,
    INetworkController _networkController,
    IRewardCalculation _rewardCalculation
  ) external initializer {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);

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
}
