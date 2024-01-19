pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IERC20WithMetadata.sol";
import "./interfaces/IRouter.sol";
import "./AccessControlledPausable.sol";
import "./interfaces/IGatewayRegistry.sol";

/**
 * @title Gateway Registry Contract
 * @dev Contract has a list of whitelisted gateways
 * Each gateway can stake tokens for a period of time to receive computation units (CUs)
 * Each gateway can allocate CUs to workers
 * Each gateway can unstake tokens
 * Allocation units are used by workers to track, if the gateway can perform queries on them
 */
contract GatewayRegistry is AccessControlledPausable, IGatewayRegistry {
  using EnumerableSet for EnumerableSet.AddressSet;

  struct Stake {
    uint256 amount;
    uint256 computationUnits;
    uint128 lockDuration;
    uint128 lockedUntil;
    uint256 unitsPerEpoch;
  }

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;

  mapping(address gateway => Stake[]) public stakes;
  IERC20WithMetadata public immutable token;
  IRouter public immutable router;
  mapping(address gateway => bytes) public peerIds;
  mapping(address gateway => uint256) public totalStaked;
  mapping(address gateway => uint256) public totalUnstaked;
  mapping(address gateway => address) public usedStrategy;
  mapping(bytes32 => address gateway) public gatewayByPeerId;
  mapping(address strategy => bool) public isStrategyAllowed;
  EnumerableSet.AddressSet private gateways;

  uint256 internal tokenDecimals;
  /// @dev How much CU is given per epoch for a single SQD, not including boost factor
  uint256 public mana = 1_000;

  event Registered(address indexed gateway, bytes peerId);
  event Staked(
    address indexed gateway, uint256 amount, uint128 duration, uint128 lockedUntil, uint256 computationUnits
  );
  event UsedStrategyChanged(address indexed gateway, bytes peerId, address strategy);
  event Unstaked(address indexed gateway, uint256 amount);
  event Unregistered(address indexed gateway, bytes peerId);

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] shares);

  event StrategyAllowed(address strategy, bool isAllowed);
  event ManaChanged(uint256 newCuPerSQD);

  constructor(IERC20WithMetadata _token, IRouter _router) {
    token = _token;
    router = _router;
    tokenDecimals = 10 ** _token.decimals();
    isStrategyAllowed[address(0)] = true;
  }

  /// @dev Register new gateway with given libP2P peerId
  function register(bytes calldata peerId) external whenNotPaused {
    require(peerIds[msg.sender].length == 0, "Gateway already registered");
    require(peerId.length > 0, "Cannot set empty peerId");
    gateways.add(msg.sender);
    bytes32 peerIdHash = keccak256(peerId);
    require(gatewayByPeerId[peerIdHash] == address(0), "PeerId already registered");
    gatewayByPeerId[peerIdHash] = msg.sender;
    peerIds[msg.sender] = peerId;

    emit Registered(msg.sender, peerId);
  }

  /// @dev Unregister gateway
  function unregister() external whenNotPaused {
    bool removed = gateways.remove(msg.sender);
    require(removed, "Gateway not registered");
    bytes memory peerId = peerIds[msg.sender];
    delete peerIds[msg.sender];

    emit Unregistered(msg.sender, peerId);
  }

  /**
   * @dev Stake tokens for a period of time
   * @notice Allocation units are given according to the non-linear formula
   * mana * duration * boostFactor, where boostFactor is specified in reward calculation contract
   * All stakes are stored separately, so that we can track, when funds are unlocked
   */
  function stake(uint256 amount, uint128 durationEpochs) external whenNotPaused {
    require(peerIds[msg.sender].length > 0, "Gateway not registered");

    uint256 _computationUnits = computationUnitsAmount(amount, durationEpochs);
    uint128 lockedUntil = router.networkController().epochNumber() + durationEpochs;
    stakes[msg.sender].push(
      Stake(amount, _computationUnits, durationEpochs, lockedUntil, _computationUnits / durationEpochs)
    );
    totalStaked[msg.sender] += amount;
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, amount, durationEpochs, lockedUntil, _computationUnits);
  }

  /// @dev Unstake tokens. Only tokens past the lock period can be unstaked
  function unstake(uint256 amount) external whenNotPaused {
    require(amount <= unstakeable(msg.sender), "Not enough funds to unstake");
    totalUnstaked[msg.sender] += amount;
    token.transfer(msg.sender, amount);

    emit Unstaked(msg.sender, amount);
  }

  /// @dev The default strategy used is address(0) which is a manual allocation submitting
  function useStrategy(address strategy) external {
    require(isStrategyAllowed[strategy], "Strategy not allowed");
    require(peerIds[msg.sender].length > 0, "Gateway not registered");
    usedStrategy[msg.sender] = strategy;

    emit UsedStrategyChanged(msg.sender, peerIds[msg.sender], strategy);
  }

  function getUsedStrategy(bytes calldata peerId) external view returns (address) {
    return usedStrategy[gatewayByPeerId[keccak256(peerId)]];
  }

  /// @return Amount of computation units available for the gateway in the current epoch
  function computationUnitsAvailable(bytes calldata peerId) external view returns (uint256) {
    Stake[] memory _stakes = stakes[gatewayByPeerId[keccak256(peerId)]];
    uint256 total = 0;
    uint256 currentEpoch = uint256(router.networkController().epochNumber());
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil > currentEpoch) {
        total += _stake.unitsPerEpoch;
      }
    }
    return total;
  }

  /**
   * @dev Allocate computation units to workers
   * Allocates i-th amount of cus to the worker with i-ths workerId
   * Sum of all cus should not exceed the amount of available cus
   */
  function allocateComputationUnits(uint256[] calldata workerId, uint256[] calldata cus) external whenNotPaused {
    require(workerId.length == cus.length, "Length mismatch");
    uint256 newlyAllocated = 0;
    uint256 workerIdCap = router.workerRegistration().nextWorkerId();
    for (uint256 i = 0; i < workerId.length; i++) {
      require(workerId[i] < workerIdCap, "Worker does not exist");
      newlyAllocated += cus[i];
    }
    require(newlyAllocated <= 10000, "Over 100% of CUs allocated");

    emit AllocatedCUs(msg.sender, peerIds[msg.sender], workerId, cus);
  }

  /// @return How much computation units will be allocated for given staked amount and duration
  function computationUnitsAmount(uint256 amount, uint256 duration) public view returns (uint256) {
    return amount * duration * mana * router.rewardCalculation().boostFactor(duration)
      / (BASIS_POINT_MULTIPLIER * tokenDecimals);
  }

  /// @return Amount of tokens staked by the gateway
  function staked(address gateway) external view returns (uint256) {
    return totalStaked[gateway] - totalUnstaked[gateway];
  }

  /// @return Amount of tokens that can be unstaked by the gateway
  function unstakeable(address gateway) public view returns (uint256) {
    Stake[] memory _stakes = stakes[gateway];
    uint256 currentEpoch = uint256(router.networkController().epochNumber());
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil <= currentEpoch) {
        total += _stake.amount;
      }
    }
    return total - totalUnstaked[msg.sender];
  }

  /// @return List of all stakes made by the gateway
  function getStakes(address user) external view returns (Stake[] memory) {
    return stakes[user];
  }

  /// @return List of all registered gateways
  function getGateways() external view returns (address[] memory) {
    return gateways.values();
  }

  function setIsStrategyAllowed(address strategy, bool isAllowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
    isStrategyAllowed[strategy] = isAllowed;

    emit StrategyAllowed(strategy, isAllowed);
  }

  function setMana(uint256 _newMana) external onlyRole(DEFAULT_ADMIN_ROLE) {
    mana = _newMana;

    emit ManaChanged(_newMana);
  }
}
