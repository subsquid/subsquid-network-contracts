pragma solidity 0.8.20;

import {UD60x18, ud, convert} from "@prb/math/src/UD60x18.sol";
import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import "./interfaces/IRouter.sol";

/*
* @dev Softly cap effective stake on workers
* The contract is used to limit the ability of stakers to heavily influence the reward distribution
* The cap function is designd to be near linear for small values and to approach 1/3 for large values
* So the weight of delegations never exceeds 1/3 of the total stake
*/
contract SoftCap {
  IRouter public router;

  constructor(IRouter _router) {
    router = _router;
  }

  /// @dev Slightly modified normal distribution
  /// 2/3^(x-1)^4-2/3
  function cap(UD60x18 x) public pure returns (UD60x18) {
    SD59x18 exponent = (x.intoSD59x18() - sd(1e18)).powu(4);
    return ((sd(2e18) / sd(3e18)).pow(exponent) - sd(2e18) / sd(3e18)).intoUD60x18();
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
    uint256[] memory workers = new uint256[](1);
    workers[0] = workerId;
    return router.staking().activeStake(workers);
  }

  function _capStake(uint256 stake) internal view returns (uint256) {
    uint256 bond = router.networkController().bondAmount();
    uint256 total = stake + bond;
    UD60x18 stakingShare = convert(stake) / convert(total);
    return uint256(convert(cap(stakingShare) * convert(bond)));
  }
}
