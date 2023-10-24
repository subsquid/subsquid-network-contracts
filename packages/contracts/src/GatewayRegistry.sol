pragma solidity 0.8.18;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "forge-std/console2.sol";
import "./RewardCalculation.sol";

contract GatewayRegistry {
  using EnumerableSet for EnumerableSet.AddressSet;

  struct Stake {
    uint256 amount;
    uint256 lockedUntil;
  }
  //    uint128 cus;
  //    uint128 cusPerSQD;

  event Staked(address indexed gateway, uint256 amount, uint256 duration, uint256 lockedUntil);

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;
  uint256 constant YEAR = 365 days;

  mapping(address gateway => Stake[]) public stakes;
  IERC20 public immutable token;
  RewardCalculation public immutable rewards;
  EnumerableSet.AddressSet private gateways;

  uint256 public baseApyBP = 1200;
  uint256 public cuPerSQD = 4000;

  constructor(IERC20 _token, RewardCalculation _rewardCalculation) {
    token = _token;
    rewards = _rewardCalculation;
  }

  function stake(uint256 amount, uint256 duration) external {
    gateways.add(msg.sender);
    uint256 lockedUntil = _pushStake(amount, duration);
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, amount, duration, lockedUntil);
  }

  function allocatedCUs(uint256 amount, uint256 duration) public view returns (uint) {
    return uint(
      amount * duration * baseApyBP * cuPerSQD * rewards.boostFactor(duration) / YEAR / BASIS_POINT_MULTIPLIER
        / BASIS_POINT_MULTIPLIER
    );
  }

  function _pushStake(uint256 amount, uint256 duration) internal returns (uint256) {
    uint256 lockedUntil = block.timestamp + duration;
    Stake[] storage _stakes = stakes[msg.sender];
    _stakes.push(Stake(amount, lockedUntil));
    //    for (uint256 i = 0; i < _stakes.length - 1; i++) {
    //      if (_stakes[i].lockedUntil > lockedUntil) {
    //        for (uint256 j = _stakes.length - 1; j > i; j--) {
    //          _stakes[j] = _stakes[j - 1];
    //        }
    //        _stakes[i] = Stake(amount, lockedUntil);
    //        return lockedUntil;
    //      }
    //    }
    //    _stakes[_stakes.length - 1] = Stake(amount, lockedUntil);
    return lockedUntil;
  }

  function unstake(uint256 amount) external {
    Stake[] storage _stakes = stakes[msg.sender];
    uint256 remaining = amount;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil <= block.timestamp) {
        if (_stake.amount <= remaining) {
          remaining -= _stake.amount;
          _stakes[i].amount = 0;
        } else {
          _stakes[i].amount -= remaining;
          remaining = 0;
          break;
        }
      }
    }
    require(remaining == 0, "Not enough funds to unstake");
    token.transfer(msg.sender, amount);
  }

  function staked(address gateway) public view returns (uint256) {
    Stake[] memory _stakes = stakes[gateway];
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      total += _stakes[i].amount;
    }
    return total;
  }

  function getGateways() external view returns (address[] memory) {
    return gateways.values();
  }

  function unstakeable(address gateway) public view returns (uint256) {
    Stake[] memory _stakes = stakes[gateway];
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil <= block.timestamp) {
        total += _stake.amount;
      }
    }
    return total;
  }

  function getStakes(address user) external view returns (Stake[] memory) {
    return stakes[user];
  }
}
