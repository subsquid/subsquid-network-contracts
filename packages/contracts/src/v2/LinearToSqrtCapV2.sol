// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {UD60x18, ud, convert} from "@prb/math/src/UD60x18.sol";
import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IRouter.sol";

contract LinearToSqrtCapV2 is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
  IRouter public router;
  uint256 public linearEnd;
  UD60x18 public sqrtCoefficient;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(IRouter _router) external initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    router = _router;
    setLinearEnd(20000 ether);
  }

  function setLinearEnd(uint256 _linearEnd) public onlyRole(DEFAULT_ADMIN_ROLE) {
    linearEnd = _linearEnd;
    sqrtCoefficient = convert(_linearEnd).sqrt();
  }

  function capedStake(uint256 workerId) public view returns (uint256) {
    return _capStake(_getStake(workerId));
  }

  function capedStakeAfterDelegation(uint256 workerId, int256 delegationAmount) public view returns (uint256) {
    int256 stakeAfterDelegation = int256(_getStake(workerId)) + delegationAmount;
    if (stakeAfterDelegation < 0) {
      return 0;
    }
    return _capStake(uint256(stakeAfterDelegation));
  }

  function _getStake(uint256 workerId) internal view returns (uint256) {
    return router.staking().delegated(workerId);
  }

  function _capStake(uint256 stake) internal view returns (uint256) {
    if (stake <= linearEnd) {
      return stake;
    }
    return convert(convert(stake).sqrt() * sqrtCoefficient);
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[47] private __gap;
}
