pragma solidity 0.8.20;

import {UD60x18, ud, convert} from "@prb/math/src/UD60x18.sol";
import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import "./interfaces/IRouter.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/*
* @dev Softly cap effective stake on workers
* The contract is used to limit the ability of stakers to heavily influence the reward distribution
* The cap function is designed to be near linear for small values and to approach 1/3 for large values
* So the weight of delegations never exceeds 1/3 of the total stake
*/
contract LinearToSqrtCap is AccessControl {
  IRouter public router;
  uint256 public linearEnd;
  UD60x18 public sqrtCoefficient;

  constructor(IRouter _router) {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

    router = _router;
    setLinearEnd(20000 ether);
  }

  function setLinearEnd(uint256 _linearEnd) public onlyRole(DEFAULT_ADMIN_ROLE) {
    linearEnd = _linearEnd;
    sqrtCoefficient = convert(_linearEnd).sqrt();
  }

  /// @dev Get caped stake of a worker (should be not more than bond / 3)
  function capedStake(uint256 workerId) public view returns (uint256) {
    return _capStake(_getStake(workerId));
  }

  /// @dev How will the stake change after delegation
  /// In case of unstake, delegation can be negative
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
}
