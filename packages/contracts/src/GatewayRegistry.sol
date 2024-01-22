pragma solidity 0.8.20;

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
  struct Stake {
    uint256 amount;
    uint256 computationUnits;
    uint128 lockDuration;
    uint128 lockedUntil;
    uint256 unitsPerEpoch;
  }

  struct Gateway {
    address operator;
    bytes peerId;
    address strategy;
    address ownAddress;
    string metadata;
    uint totalStaked;
    uint totalUnstaked;
    Stake[] stakes;
  }

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;

  IERC20WithMetadata public immutable token;
  IRouter public immutable router;
  mapping(bytes32 gatewayId => Gateway gateway) internal gateways;
  mapping(address => bytes32 gatewayId) public gatewayByAddress;
  mapping(address strategy => bool) public isStrategyAllowed;
  address public defaultStrategy;

  uint256 internal tokenDecimals;
  /// @dev How much CU is given per epoch for a single SQD, not including boost factor
  uint256 public mana = 1_000;

  event Registered(address indexed gateway, bytes32 indexed id, bytes peerId);
  event Staked(
    address indexed gateway, bytes peerId, uint256 amount, uint128 duration, uint128 lockedUntil, uint256 computationUnits
  );
  event UsedStrategyChanged(address indexed gateway, bytes peerId, address strategy);
  event Unstaked(address indexed gateway, bytes peerId, uint256 amount);
  event Unregistered(address indexed gateway, bytes peerId);

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] shares);

  event StrategyAllowed(address indexed strategy, bool isAllowed);
  event DefaultStrategyChanged(address indexed strategy);
  event ManaChanged(uint256 newCuPerSQD);

  constructor(IERC20WithMetadata _token, IRouter _router) {
    token = _token;
    router = _router;
    tokenDecimals = 10 ** _token.decimals();
    isStrategyAllowed[address(0)] = true;
  }

  function register(bytes calldata peerId) external {
    register(peerId, "", address(0));
  }

  function register(bytes calldata peerId, string calldata metadata) external {
    register(peerId, metadata, address(0));
  }

  /// @dev Register new gateway with given libP2P peerId
  function register(bytes calldata peerId, string memory metadata, address gatewayAddress) public whenNotPaused {
    require(peerId.length > 0, "Cannot set empty peerId");
    bytes32 peerIdHash = keccak256(peerId);
    require(gateways[peerIdHash].operator == address(0), "PeerId already registered");
    if (address(gatewayAddress) != address(0)) {
      require(gatewayByAddress[gatewayAddress] == bytes32(0), "Gateway address already registered");
      gatewayByAddress[gatewayAddress] = peerIdHash;
    }
    gateways[peerIdHash] = Gateway(msg.sender, peerId, address(0), gatewayAddress, metadata, 0, 0, new Stake[](0));

    emit Registered(msg.sender, peerIdHash, peerId);

    useStrategy(peerId, defaultStrategy);
  }

  /// @dev Unregister gateway
  function unregister(bytes calldata peerId) external whenNotPaused {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);
    require(gateway.totalStaked == gateway.totalUnstaked, "Gateway has staked tokens");
    delete gatewayByAddress[gateway.ownAddress];
    delete gateways[peerIdHash];

    emit Unregistered(msg.sender, peerId);
  }

  /**
   * @dev Stake tokens for a period of time
   * @notice Allocation units are given according to the non-linear formula
   * mana * duration * boostFactor, where boostFactor is specified in reward calculation contract
   * All stakes are stored separately, so that we can track, when funds are unlocked
   */
  function stake(bytes calldata peerId, uint256 amount, uint128 durationEpochs) public whenNotPaused {
    _stakeWithoutTransfer(peerId, amount, durationEpochs);
    token.transferFrom(msg.sender, address(this), amount);
  }

  function _stakeWithoutTransfer(bytes calldata peerId, uint256 amount, uint128 durationEpochs) internal {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);

    uint256 _computationUnits = computationUnitsAmount(amount, durationEpochs);
    uint128 lockedUntil = router.networkController().epochNumber() + durationEpochs;
    gateway.stakes.push(
      Stake(amount, _computationUnits, durationEpochs, lockedUntil, _computationUnits / durationEpochs)
    );
    gateway.totalStaked += amount;

    emit Staked(msg.sender, peerId, amount, durationEpochs, lockedUntil, _computationUnits);
  }

  /// @dev Unstake tokens. Only tokens past the lock period can be unstaked
  function unstake(bytes calldata peerId, uint256 amount) public whenNotPaused {
    _unstakeWithoutTransfer(peerId, amount);
    token.transfer(msg.sender, amount);
  }

  function _unstakeWithoutTransfer(bytes calldata peerId, uint256 amount) internal {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);
    require(amount <= _unstakeable(gateway), "Not enough funds to unstake");
    gateway.totalUnstaked += amount;

    emit Unstaked(msg.sender, peerId, amount);
  }

  function extend(bytes calldata peerId, uint256 amount, uint128 durationEpochs) external whenNotPaused {
    _unstakeWithoutTransfer(peerId, amount);
    _stakeWithoutTransfer(peerId, amount, durationEpochs);
  }

  /// @dev The default strategy used is address(0) which is a manual allocation submitting
  function useStrategy(bytes calldata peerId, address strategy) public {
    require(isStrategyAllowed[strategy], "Strategy not allowed");
    (Gateway storage gateway,) = _getGateway(peerId);
    _requireOperator(gateway);
    gateway.strategy = strategy;

    emit UsedStrategyChanged(msg.sender, peerId, strategy);
  }

  function getUsedStrategy(bytes calldata peerId) external view returns (address) {
    (Gateway storage gateway,) = _getGateway(peerId);
    return gateway.strategy;
  }

  /// @return Amount of computation units available for the gateway in the current epoch
  function computationUnitsAvailable(bytes calldata peerId) external view returns (uint256) {
    (Gateway storage gateway,) = _getGateway(peerId);
    Stake[] memory _stakes = gateway.stakes;
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
  function allocateComputationUnits(bytes calldata peerId, uint256[] calldata workerId, uint256[] calldata cus) external whenNotPaused {
    require(workerId.length == cus.length, "Length mismatch");
    (Gateway storage gateway,) = _getGateway(peerId);
    _requireOperator(gateway);
    uint256 newlyAllocated = 0;
    uint256 workerIdCap = router.workerRegistration().nextWorkerId();
    for (uint256 i = 0; i < workerId.length; i++) {
      require(workerId[i] < workerIdCap, "Worker does not exist");
      newlyAllocated += cus[i];
    }
    require(newlyAllocated <= 10000, "Over 100% of CUs allocated");

    emit AllocatedCUs(msg.sender, peerId, workerId, cus);
  }

  /// @return How much computation units will be allocated for given staked amount and duration
  function computationUnitsAmount(uint256 amount, uint256 duration) public view returns (uint256) {
    return amount * duration * mana * router.rewardCalculation().boostFactor(duration)
      / (BASIS_POINT_MULTIPLIER * tokenDecimals);
  }

  /// @return Amount of tokens staked by the gateway
  function staked(bytes calldata peerId) external view returns (uint256) {
    (Gateway storage gateway,) = _getGateway(peerId);
    return gateway.totalStaked - gateway.totalUnstaked;
  }

  function unstakeable(bytes calldata peerId) external view returns (uint256) {
    (Gateway storage gateway,) = _getGateway(peerId);
    return _unstakeable(gateway);
  }

  /// @return Amount of tokens that can be unstaked by the gateway
  function _unstakeable(Gateway storage gateway) internal view returns (uint256) {
    Stake[] memory _stakes = gateway.stakes;
    uint256 currentEpoch = uint256(router.networkController().epochNumber());
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockedUntil <= currentEpoch) {
        total += _stake.amount;
      }
    }
    return total - gateway.totalUnstaked;
  }

  /// @return List of all stakes made by the gateway
  function getStakes(bytes calldata peerId, uint index) external view returns (Stake memory) {
    (Gateway storage gateway,) = _getGateway(peerId);
    return gateway.stakes[index];
  }

  function getGateway(bytes calldata peerId) external view returns (Gateway memory) {
    return gateways[keccak256(peerId)];
  }

  function setIsStrategyAllowed(address strategy, bool isAllowed, bool isDefault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    isStrategyAllowed[strategy] = isAllowed;
    if (isDefault) {
      defaultStrategy = strategy;
      emit DefaultStrategyChanged(strategy);
    }
    emit StrategyAllowed(strategy, isAllowed);
  }

  function setMana(uint256 _newMana) external onlyRole(DEFAULT_ADMIN_ROLE) {
    mana = _newMana;

    emit ManaChanged(_newMana);
  }

  function _getGateway(bytes calldata peerId) internal view returns (Gateway storage gateway, bytes32 peerIdHash) {
    peerIdHash = keccak256(peerId);
    gateway = gateways[peerIdHash];
    require(gateway.operator != address(0), "Gateway not registered");
  }

  function _requireOperator(Gateway storage _gateway) internal view {
    require(_gateway.operator == msg.sender, "Only operator can call this function");
  }
}
