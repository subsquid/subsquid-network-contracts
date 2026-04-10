// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";

import "../interfaces/IRouter.sol";
import "../interfaces/IRewardCalculation.sol";
import "../interfaces/IRewardCalculationHook.sol";
import "../libs/Errors.sol";

/**
 * @title RewardCalculationV2
 * @dev UUPS-upgradeable reward calculation with cached active-worker aggregates.
 *      The hot path no longer enumerates the full active-worker set on every read.
 */
contract RewardCalculationV2 is
  Initializable,
  AccessControlUpgradeable,
  UUPSUpgradeable,
  IRewardCalculation,
  IRewardCalculationHook
{
  using SafeCast for uint256;
  using SafeCast for int256;

  IRouter public router;
  /// @dev Stake cap contract address - uses a generic interface since SoftCap/LinearToSqrtCap have same functions
  address public stakeCap;
  uint256 public constant INITIAL_REWARD_POOL_SIZE = 120_330_000 ether;

  uint256 public settledActiveWorkerCount;
  uint256 public settledEffectiveStake;

  mapping(uint256 workerId => uint256 cappedStake) public trackedWorkerCappedStake;
  mapping(uint256 workerId => uint128 activationEpoch) internal scheduledActivationEpochByWorker;
  mapping(uint256 workerId => uint128 deactivationEpoch) internal scheduledDeactivationEpochByWorker;

  uint128[] internal activationEpochs;
  mapping(uint128 epoch => uint256 count) internal scheduledActivations;
  mapping(uint128 epoch => uint256 effectiveStake) internal scheduledActivationStake;
  uint256 internal activationCursor;

  uint128[] internal deactivationEpochs;
  mapping(uint128 epoch => uint256 count) internal scheduledDeactivations;
  mapping(uint128 epoch => uint256 effectiveStake) internal scheduledDeactivationStake;
  uint256 internal deactivationCursor;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(IRouter _router, address _stakeCap) external initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    router = _router;
    _setStakeCap(_stakeCap);
  }

  function setStakeCap(address _stakeCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setStakeCap(_stakeCap);
  }

  function onWorkerRegistered(uint256 workerId, uint128 activationBlock) external {
    _requireWorkerRegistration();
    _settleMaturedLifecycle();

    _scheduleActivation(activationBlock, trackedWorkerCappedStake[workerId]);
    scheduledActivationEpochByWorker[workerId] = activationBlock;
  }

  function onWorkerDeregistered(uint256 workerId, uint128 deactivationBlock) external {
    _requireWorkerRegistration();
    _settleMaturedLifecycle();

    _scheduleDeactivation(deactivationBlock, trackedWorkerCappedStake[workerId]);
    scheduledDeactivationEpochByWorker[workerId] = deactivationBlock;
  }

  function onDelegationWillChange(uint256 workerId, int256 delegationDelta) external {
    _requireStaking();
    _settleMaturedLifecycle();

    uint256 currentCappedStake = _cappedStake(workerId);
    uint256 nextCappedStake = _cappedStakeAfterDelegation(workerId, delegationDelta);

    if (router.workerRegistration().isWorkerActive(workerId)) {
      settledEffectiveStake = _replaceValue(settledEffectiveStake, currentCappedStake, nextCappedStake);
    }

    uint128 activationEpoch = scheduledActivationEpochByWorker[workerId];
    if (activationEpoch > block.number) {
      scheduledActivationStake[activationEpoch] =
        _replaceValue(scheduledActivationStake[activationEpoch], currentCappedStake, nextCappedStake);
    }

    uint128 deactivationEpoch = scheduledDeactivationEpochByWorker[workerId];
    if (deactivationEpoch > block.number) {
      scheduledDeactivationStake[deactivationEpoch] =
        _replaceValue(scheduledDeactivationStake[deactivationEpoch], currentCappedStake, nextCappedStake);
    }

    trackedWorkerCappedStake[workerId] = nextCappedStake;
  }

  function syncWorkerLifecycle() external {
    _settleMaturedLifecycle();
  }

  /// @dev APY based on target and actual storages
  function baseApr(uint256 target, uint256 actual) public pure returns (uint256) {
    require(target > 0, "Target capacity cannot be 0");
    int256 uRate = (target.toInt256() - actual.toInt256()) * 10000 / target.toInt256();
    if (uRate >= 9000) {
      return 7000;
    }
    if (uRate >= 0) {
      return 2500 + uRate.toUint256() / 2;
    }
    int256 resultApy = 2000 + uRate / 20;
    if (resultApy < 0) {
      return 0;
    }
    return resultApy.toUint256();
  }

  function apyCap() public view returns (uint256) {
    uint256 tvl = effectiveTVL();
    if (tvl == 0) {
      return 10000;
    }
    return router.networkController().yearlyRewardCapCoefficient() * INITIAL_REWARD_POOL_SIZE / tvl;
  }

  function apy(uint256 target, uint256 actual) public view returns (uint256) {
    uint256 base = baseApr(target, actual);
    uint256 maxApy = apyCap();
    if (base > maxApy) {
      return maxApy;
    }
    return base;
  }

  function effectiveTVL() public view returns (uint256) {
    uint256 workerCount = _currentActiveWorkerCount();
    uint256 bond = router.networkController().bondAmount();
    return _currentEffectiveStake() + workerCount * bond;
  }

  function currentApy() public view returns (uint256) {
    return apy(
      router.networkController().targetCapacityGb(),
      _currentActiveWorkerCount() * router.networkController().storagePerWorkerInGb()
    );
  }

  function epochReward(uint256 epochLengthInSeconds) public view returns (uint256) {
    return currentApy() * effectiveTVL() * epochLengthInSeconds / 365 days / 10000;
  }

  function boostFactor(uint256 duration) public pure returns (uint256) {
    if (duration < 60 days) {
      return 10000;
    }
    if (duration < 180 days) {
      return 10000 + (duration - 30 days) / 30 days * 2000;
    }
    if (duration < 360 days) {
      return 20000;
    }
    if (duration < 720 days) {
      return 25000;
    }
    return 30000;
  }

  function _setStakeCap(address _stakeCap) internal {
    if (_stakeCap == address(0)) revert Errors.ZeroAddress();
    if (_stakeCap.code.length == 0) revert Errors.InvalidStakeCap();
    stakeCap = _stakeCap;
  }

  function _currentActiveWorkerCount() internal view returns (uint256 count) {
    count = settledActiveWorkerCount;

    for (uint256 i = activationCursor; i < activationEpochs.length; i++) {
      uint128 epoch = activationEpochs[i];
      if (epoch > block.number) break;
      count += scheduledActivations[epoch];
    }

    for (uint256 i = deactivationCursor; i < deactivationEpochs.length; i++) {
      uint128 epoch = deactivationEpochs[i];
      if (epoch > block.number) break;
      count -= scheduledDeactivations[epoch];
    }
  }

  function _currentEffectiveStake() internal view returns (uint256 stake) {
    stake = settledEffectiveStake;

    for (uint256 i = activationCursor; i < activationEpochs.length; i++) {
      uint128 epoch = activationEpochs[i];
      if (epoch > block.number) break;
      stake += scheduledActivationStake[epoch];
    }

    for (uint256 i = deactivationCursor; i < deactivationEpochs.length; i++) {
      uint128 epoch = deactivationEpochs[i];
      if (epoch > block.number) break;
      stake -= scheduledDeactivationStake[epoch];
    }
  }

  function _settleMaturedLifecycle() internal {
    while (activationCursor < activationEpochs.length && activationEpochs[activationCursor] <= block.number) {
      uint128 epoch = activationEpochs[activationCursor];
      settledActiveWorkerCount += scheduledActivations[epoch];
      settledEffectiveStake += scheduledActivationStake[epoch];
      activationCursor++;
    }

    while (deactivationCursor < deactivationEpochs.length && deactivationEpochs[deactivationCursor] <= block.number) {
      uint128 epoch = deactivationEpochs[deactivationCursor];
      settledActiveWorkerCount -= scheduledDeactivations[epoch];
      settledEffectiveStake -= scheduledDeactivationStake[epoch];
      deactivationCursor++;
    }
  }

  function _scheduleActivation(uint128 epoch, uint256 cappedStake) internal {
    if (activationEpochs.length == 0 || activationEpochs[activationEpochs.length - 1] != epoch) {
      activationEpochs.push(epoch);
    }
    scheduledActivations[epoch] += 1;
    scheduledActivationStake[epoch] += cappedStake;
  }

  function _scheduleDeactivation(uint128 epoch, uint256 cappedStake) internal {
    if (deactivationEpochs.length == 0 || deactivationEpochs[deactivationEpochs.length - 1] != epoch) {
      deactivationEpochs.push(epoch);
    }
    scheduledDeactivations[epoch] += 1;
    scheduledDeactivationStake[epoch] += cappedStake;
  }

  function _cappedStake(uint256 workerId) internal view returns (uint256 cappedStake) {
    (bool success, bytes memory data) = stakeCap.staticcall(abi.encodeWithSignature("capedStake(uint256)", workerId));
    if (!success || data.length < 32) revert Errors.StakeCapCallFailed();
    cappedStake = abi.decode(data, (uint256));
  }

  function _cappedStakeAfterDelegation(uint256 workerId, int256 delegationDelta)
    internal
    view
    returns (uint256 cappedStake)
  {
    (bool success, bytes memory data) = stakeCap.staticcall(
      abi.encodeWithSignature("capedStakeAfterDelegation(uint256,int256)", workerId, delegationDelta)
    );
    if (!success || data.length < 32) revert Errors.StakeCapCallFailed();
    cappedStake = abi.decode(data, (uint256));
  }

  function _replaceValue(uint256 total, uint256 previousValue, uint256 newValue)
    internal
    pure
    returns (uint256 updated)
  {
    updated = total;
    if (newValue >= previousValue) {
      updated += newValue - previousValue;
    } else {
      updated -= previousValue - newValue;
    }
  }

  function _requireWorkerRegistration() internal view {
    require(msg.sender == address(router.workerRegistration()), "Only worker registration");
  }

  function _requireStaking() internal view {
    require(msg.sender == address(router.staking()), "Only staking");
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[37] private __gap;
}
