pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IERC20WithMetadata.sol";
import "./RewardCalculation.sol";
import "forge-std/console2.sol";

contract GatewayRegistry {
  using EnumerableSet for EnumerableSet.AddressSet;

  struct Stake {
    uint256 amount;
    uint256 lockedUntil;
    uint256 computationUnits;
  }

  event Staked(address indexed gateway, uint256 amount, uint256 duration, uint256 lockedUntil);

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;
  uint256 constant ADDITIONAL_PRECISION = 1e18;
  uint256 constant YEAR = 360 days;

  mapping(address gateway => Stake[]) public stakes;
  IERC20WithMetadata public immutable token;
  IRouter public immutable router;
  mapping(address gateway => bytes) public peerIds;
  mapping(address gateway => uint256) public allocatedComputationUnits;
  EnumerableSet.AddressSet private gateways;

  uint256 public baseApyBP = 1200;
  uint256 public cuPerSQD = 4000;
  uint256 internal tokenDecimals;

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] cus);

  constructor(IERC20WithMetadata _token, IRouter _router) {
    token = _token;
    router = _router;
    tokenDecimals = 10 ** _token.decimals();
  }

  function register(bytes calldata peerId) external {
    require(peerIds[msg.sender].length == 0, "Gateway already registered");
    require(peerId.length > 0, "Cannot set empty peerId");
    gateways.add(msg.sender);
    peerIds[msg.sender] = peerId;
  }

  function unregister() external {
    bool removed = gateways.remove(msg.sender);
    require(removed, "Gateway not registered");
    delete peerIds[msg.sender];
  }

  function stake(uint256 amount, uint256 duration) external {
    require(peerIds[msg.sender].length > 0, "Gateway not registered");

    uint256 lockedUntil = _pushStake(amount, duration);
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, amount, duration, lockedUntil);
  }

  function availableCUs(uint256 amount, uint256 duration) public view returns (uint256) {
    return amount * duration * baseApyBP * cuPerSQD * router.rewardCalculation().boostFactor(duration) / YEAR
      / BASIS_POINT_MULTIPLIER / BASIS_POINT_MULTIPLIER / tokenDecimals;
  }

  function _pushStake(uint256 amount, uint256 duration) internal returns (uint256) {
    uint256 lockedUntil = block.timestamp + duration;
    Stake[] storage _stakes = stakes[msg.sender];
    uint256 _computationUnits = availableCUs(amount, duration);
    uint256 cuPerStd = _computationUnits * ADDITIONAL_PRECISION / amount;
    _stakes.push();
    for (uint256 i = 0; i < _stakes.length - 1; i++) {
      if (_stakes[i].computationUnits * ADDITIONAL_PRECISION / _stakes[i].amount > cuPerStd) {
        for (uint256 j = _stakes.length - 1; j > i; j--) {
          _stakes[j] = _stakes[j - 1];
        }
        _stakes[i] = Stake(amount, lockedUntil, _computationUnits);
        return lockedUntil;
      }
    }
    _stakes[_stakes.length - 1] = Stake(amount, lockedUntil, _computationUnits);
    return lockedUntil;
  }

  function unstake(uint256 amount) external {
    Stake[] storage _stakes = stakes[msg.sender];
    uint256 remaining = amount;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil <= block.timestamp) {
        if (_stake.amount < remaining) {
          remaining -= _stake.amount;
          _stakes[i].amount = 0;
          _stakes[i].computationUnits = 0;
        } else {
          _stakes[i].computationUnits -= _stake.computationUnits * remaining / _stake.amount;
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

  // TODO
  // check if the worker is registered
  // check if cu[i] is not 0
  function allocateComputationUnits(uint256[] calldata workerId, uint256[] calldata cus) external {
    require(workerId.length == cus.length, "Length mismatch");
    uint256 newlyAllocated = 0;
    for (uint256 i = 0; i < workerId.length; i++) {
      newlyAllocated += cus[i];
    }
    allocatedComputationUnits[msg.sender] += newlyAllocated;
    require(computationUnits(msg.sender) >= 0, "Not enough computation units");

    emit AllocatedCUs(msg.sender, peerIds[msg.sender], workerId, cus);
  }

  function computationUnits(address gateway) public view returns (uint256) {
    uint256 total = 0;
    Stake[] memory _stakes = stakes[gateway];
    for (uint256 i = 0; i < _stakes.length; i++) {
      total += _stakes[i].computationUnits;
    }
    return total - allocatedComputationUnits[gateway];
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
