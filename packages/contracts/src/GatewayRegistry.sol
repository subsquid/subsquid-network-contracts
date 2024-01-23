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
    uint128 lockStart;
    uint128 lockEnd;
  }

  struct Gateway {
    address operator;
    bytes peerId;
    address strategy;
    address ownAddress;
    string metadata;
    uint256 totalStaked;
    uint256 totalUnstaked;
  }

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;

  IERC20WithMetadata public immutable token;
  IRouter public immutable router;
  mapping(bytes32 gatewayId => Gateway gateway) internal gateways;
  mapping(bytes32 gatewayId => Stake[]) internal stakes;
  mapping(address => bytes32 gatewayId) public gatewayByAddress;
  mapping(address strategy => bool) public isStrategyAllowed;
  address public defaultStrategy;

  uint256 internal tokenDecimals;
  uint256 public averageBlockTime = 12 seconds;
  /// @dev How much CU is given for a single SQD per 1000 blocks, not including boost factor
  uint256 public mana = 1_000;

  event Registered(address indexed gatewayOperator, bytes32 indexed id, bytes peerId);
  event Staked(
    address indexed gatewayOperator,
    bytes peerId,
    uint256 amount,
    uint128 lockStart,
    uint128 lockEnd,
    uint256 computationUnits
  );
  event Unstaked(address indexed gatewayOperator, bytes peerId, uint256 amount);
  event Unregistered(address indexed gatewayOperator, bytes peerId);

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] shares);

  event StrategyAllowed(address indexed strategy, bool isAllowed);
  event DefaultStrategyChanged(address indexed strategy);
  event ManaChanged(uint256 newCuPerSQD);

  event MetadataChanged(address indexed gatewayOperator, bytes peerId, string metadata);
  event GatewayAddressChanged(address indexed gatewayOperator, bytes peerId, address newAddress);
  event UsedStrategyChanged(address indexed gatewayOperator, bytes peerId, address strategy);

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

    gateways[peerIdHash] = Gateway({
      operator: msg.sender,
      peerId: peerId,
      strategy: defaultStrategy,
      ownAddress: gatewayAddress,
      metadata: metadata,
      totalStaked: 0,
      totalUnstaked: 0
    });

    emit Registered(msg.sender, peerIdHash, peerId);

    setGatewayAddress(peerId, gatewayAddress);
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

  function _stakeWithoutTransfer(bytes calldata peerId, uint256 amount, uint128 durationBlocks) internal {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);

    uint256 _computationUnits = computationUnitsAmount(amount, durationBlocks);
    uint128 lockStart = router.networkController().nextEpoch();
    uint128 lockEnd = lockStart + durationBlocks;
    stakes[peerIdHash].push(Stake(amount, _computationUnits, lockStart, lockEnd));
    gateway.totalStaked += amount;

    emit Staked(msg.sender, peerId, amount, lockStart, lockEnd, _computationUnits);
  }

  /// @dev Unstake tokens. Only tokens past the lock period can be unstaked
  function unstake(bytes calldata peerId, uint256 amount) public whenNotPaused {
    _unstakeWithoutTransfer(peerId, amount);
    token.transfer(msg.sender, amount);
  }

  function _unstakeWithoutTransfer(bytes calldata peerId, uint256 amount) internal {
    (Gateway storage gateway,) = _getGateway(peerId);
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
    Stake[] memory _stakes = stakes[keccak256(peerId)];
    uint256 total = 0;
    uint256 blockNumber = block.number;
    uint256 epochLength = uint256(router.networkController().epochLength());
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockStart <= blockNumber && _stake.lockEnd > blockNumber) {
        total += _stake.computationUnits * epochLength / (uint256(_stake.lockEnd - _stake.lockStart));
      }
    }
    return total;
  }

  /**
   * @dev Allocate computation units to workers
   * Allocates i-th amount of cus to the worker with i-ths workerId
   * Sum of all cus should not exceed the amount of available cus
   */
  function allocateComputationUnits(bytes calldata peerId, uint256[] calldata workerId, uint256[] calldata cus)
    external
    whenNotPaused
  {
    require(workerId.length == cus.length, "Length mismatch");
    (Gateway storage gateway,) = _getGateway(peerId);
    require(gateway.ownAddress == msg.sender, "Only gateway can allocate CUs");
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
  function computationUnitsAmount(uint256 amount, uint256 durationBlocks) public view returns (uint256) {
    return amount * durationBlocks * mana * router.rewardCalculation().boostFactor(durationBlocks * averageBlockTime)
      / (BASIS_POINT_MULTIPLIER * tokenDecimals * 1000);
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
    Stake[] memory _stakes = stakes[keccak256(gateway.peerId)];
    uint256 blockNumber = block.number;
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockEnd <= blockNumber) {
        total += _stake.amount;
      }
    }
    return total - gateway.totalUnstaked;
  }

  //  /// @return List of all stakes made by the gateway
  function getStakes(bytes calldata peerId) external view returns (Stake[] memory) {
    return stakes[keccak256(peerId)];
  }

  function getGateway(bytes calldata peerId) external view returns (Gateway memory) {
    return gateways[keccak256(peerId)];
  }

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    return gateways[keccak256(peerId)].metadata;
  }

  function setMetadata(bytes calldata peerId, string calldata metadata) external {
    (Gateway storage gateway,) = _getGateway(peerId);
    _requireOperator(gateway);
    gateway.metadata = metadata;

    emit MetadataChanged(msg.sender, peerId, metadata);
  }

  function setGatewayAddress(bytes calldata peerId, address newAddress) public {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);

    if (gateway.ownAddress != address(0)) {
      delete gatewayByAddress[gateway.ownAddress];
    }

    if (address(newAddress) != address(0)) {
      require(gatewayByAddress[newAddress] == bytes32(0), "Gateway address already registered");
      gatewayByAddress[newAddress] = peerIdHash;
    }

    emit GatewayAddressChanged(msg.sender, peerId, newAddress);
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

  function setAverageBlockTime(uint256 _newAverageBlockTime) external onlyRole(DEFAULT_ADMIN_ROLE) {
    averageBlockTime = _newAverageBlockTime;
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
