pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {PausableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";

import "./interfaces/IERC20WithMetadata.sol";
import "./interfaces/IRouter.sol";
import "./interfaces/IGatewayRegistry.sol";

contract AccessControlledPausableUpgradeable is PausableUpgradeable, AccessControlUpgradeable {
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  function initialize() internal onlyInitializing {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(PAUSER_ROLE, msg.sender);
  }

  function pause() public virtual onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() public virtual onlyRole(PAUSER_ROLE) {
    _unpause();
  }
}

/**
 * @title Gateway Registry Contract
 * @dev Contract has a list of whitelisted gateways
 * Gateway operators can stake tokens for a period of time to receive computation units (CUs)
 * Allocation units are used by workers to track, if the gateway can perform queries on them
 * Allocation units are distributed between workers either by strategy contract, of if strategy is not set,
 * manually by calling `allocateComputationUnits` function
 * We call a set of gateways created by single wallet a cluster
 */
contract GatewayRegistry is AccessControlledPausableUpgradeable, IGatewayRegistry {
  using EnumerableSet for EnumerableSet.Bytes32Set;
  using EnumerableSet for EnumerableSet.AddressSet;

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;
  uint256 MAX_LOCK_DURATION = 3 * 360 days;

  struct GatewayOperator {
    bool previousInteractions;
    address strategy;
    Stake stake;
    EnumerableSet.Bytes32Set ownedGateways;
  }

  IERC20WithMetadata public token;
  IRouter public router;
  mapping(bytes32 gatewayId => Gateway gateway) gateways;
  mapping(address operator => GatewayOperator) internal operators;
  mapping(address => bytes32 gatewayId) public gatewayByAddress;
  /// @dev A set of all operators that have funds locked
  EnumerableSet.Bytes32Set internal activeGateways;

  mapping(address strategy => bool) public isStrategyAllowed;
  address public defaultStrategy;

  uint256 internal tokenDecimals;
  /// @notice Depends on the network
  uint256 public averageBlockTime;
  /// @dev How much CU is given for a single SQD per 1000 blocks, not including boost factor
  uint256 public mana;
  /// @dev How many gateways can be operated by a single wallet
  uint256 public maxGatewaysPerCluster;
  uint256 public minStake = 1;

  constructor() {
    _disableInitializers();
  }

  function initialize(IERC20WithMetadata _token, IRouter _router) external initializer {
    AccessControlledPausableUpgradeable.initialize();
    token = _token;
    router = _router;
    tokenDecimals = 10 ** _token.decimals();

    isStrategyAllowed[address(0)] = true;
    averageBlockTime = 12 seconds;
    mana = 1_000;
    maxGatewaysPerCluster = 10;
  }

  function register(bytes calldata peerId) external {
    register(peerId, "", address(0));
  }

  function register(bytes calldata peerId, string calldata metadata) external {
    register(peerId, metadata, address(0));
  }

  /**
   * @dev Register a list of gateways
   * See register function for more info
   */
  function register(bytes[] calldata peerId, string[] calldata metadata, address[] calldata gatewayAddress) external {
    require(peerId.length == metadata.length, "Length mismatch");
    require(peerId.length == gatewayAddress.length, "Length mismatch");
    for (uint256 i = 0; i < peerId.length; i++) {
      register(peerId[i], metadata[i], gatewayAddress[i]);
    }
  }

  /**
   * @dev Register new gateway with given libP2P peerId
   * If gateway address is given, the gateway can call `allocateComputationUnits` function from this address
   * If this is the first gateway for the gateway operator, the default strategy will be used
   */
  function register(bytes calldata peerId, string memory metadata, address gatewayAddress) public whenNotPaused {
    require(peerId.length > 0, "Cannot set empty peerId");
    bytes32 peerIdHash = keccak256(peerId);
    require(gateways[peerIdHash].operator == address(0), "PeerId already registered");
    require(operators[msg.sender].ownedGateways.length() < maxGatewaysPerCluster, "Too many gateways in the cluster");

    if (!operators[msg.sender].previousInteractions) {
      useStrategy(defaultStrategy);
    }
    gateways[peerIdHash] =
      Gateway({operator: msg.sender, ownAddress: gatewayAddress, peerId: peerId, metadata: metadata});
    operators[msg.sender].ownedGateways.add(peerIdHash);
    if (operators[msg.sender].stake.amount > 0) {
      activeGateways.add(peerIdHash);
    }

    emit Registered(msg.sender, peerIdHash, peerId);
    emit MetadataChanged(msg.sender, peerId, metadata);

    setGatewayAddress(peerId, gatewayAddress);
  }

  function unregister(bytes[] calldata peerId) external {
    for (uint256 i = 0; i < peerId.length; i++) {
      unregister(peerId[i]);
    }
  }

  /// @dev Unregister gateway
  function unregister(bytes calldata peerId) public whenNotPaused {
    (Gateway storage gateway, bytes32 peerIdHash) = _getGateway(peerId);
    _requireOperator(gateway);
    require(operators[msg.sender].ownedGateways.remove(peerIdHash), "Gateway not removed from operator");
    activeGateways.remove(peerIdHash);
    delete gatewayByAddress[gateway.ownAddress];
    delete gateways[peerIdHash];

    emit Unregistered(msg.sender, peerId);
  }

  /**
   * @dev Stake tokens for a period of time for the first time
   * @notice Allocation units are given according to the non-linear formula
   * Allocations are given to all gateways in the cluster
   * mana * duration * boostFactor, where boostFactor is specified in reward calculation contract
   */
  function stake(uint256 amount, uint128 durationBlocks, bool withAutoExtension) public whenNotPaused {
    require(amount >= minStake, "Cannot stake below minStake");
    require(durationBlocks >= router.networkController().epochLength(), "Cannot stake for less than an epoch");
    require(durationBlocks * averageBlockTime <= MAX_LOCK_DURATION, "Lock duration too long");
    require(operators[msg.sender].stake.amount == 0, "Stake already exists, call addStake instead");
    uint256 _computationUnits = computationUnitsAmount(amount, durationBlocks);
    uint128 lockStart = router.networkController().nextEpoch();
    uint128 lockEnd = withAutoExtension ? type(uint128).max : lockStart + durationBlocks;
    operators[msg.sender].stake = Stake(amount, lockStart, lockEnd, durationBlocks, withAutoExtension, 0);
    bytes32[] memory cluster = operators[msg.sender].ownedGateways.values();
    for (uint256 i = 0; i < cluster.length; i++) {
      activeGateways.add(cluster[i]);
    }
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, amount, lockStart, lockEnd, _computationUnits);

    if (withAutoExtension) {
      emit AutoextensionEnabled(msg.sender);
    } else {
      emit AutoextensionDisabled(msg.sender, lockEnd);
    }
  }

  function stake(uint256 amount, uint128 durationBlocks) external {
    stake(amount, durationBlocks, false);
  }

  /// @dev Add more stake to the existing one
  /// If called with amount=0, extends stake by another lock period
  function addStake(uint256 amount) public whenNotPaused {
    Stake storage _stake = operators[msg.sender].stake;
    require(_stake.amount > 0, "Cannot add stake when nothing was staked");
    require(_stake.lockStart <= block.number, "Stake is not started");
    uint256 _computationUnitsReceived = computationUnitsAmount(amount, _stake.duration);
    uint256 _oldComputationUnits = computationUnitsAmount(_stake.amount, _stake.duration);
    _stake.lockStart = router.networkController().nextEpoch();
    _stake.lockEnd = _stake.autoExtension ? type(uint128).max : _stake.lockStart + _stake.duration;
    _stake.oldCUs = _oldComputationUnits;
    _stake.amount += amount;
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, amount, _stake.lockStart, _stake.lockEnd, _computationUnitsReceived);
  }

  /// @dev Unstake tokens. Only tokens past the lock period can be unstaked
  /// All gateways in the cluster will be marked as inactive
  function unstake() external whenNotPaused {
    require(operators[msg.sender].stake.lockEnd <= block.number, "Stake is locked");
    uint256 amount = operators[msg.sender].stake.amount;
    require(amount > 0, "Nothing to unstake");
    bytes32[] memory cluster = operators[msg.sender].ownedGateways.values();
    for (uint256 i = 0; i < cluster.length; i++) {
      activeGateways.remove(cluster[i]);
    }
    delete operators[msg.sender].stake;

    token.transfer(msg.sender, amount);

    emit Unstaked(msg.sender, amount);
  }

  /// @dev set strategy contract
  /// address(0) is a manual allocation submitting
  function useStrategy(address strategy) public {
    require(isStrategyAllowed[strategy], "Strategy not allowed");
    operators[msg.sender].strategy = strategy;
    operators[msg.sender].previousInteractions = true;

    emit UsedStrategyChanged(msg.sender, strategy);
  }

  function getUsedStrategy(bytes calldata peerId) external view returns (address) {
    (Gateway storage gateway,) = _getGateway(peerId);
    return operators[gateway.operator].strategy;
  }

  /// @return Amount of computation units available for the gateway in the current epoch
  function computationUnitsAvailable(bytes calldata peerId) external view returns (uint256) {
    (Gateway storage gateway,) = _getGateway(peerId);

    Stake memory _stake = operators[gateway.operator].stake;
    uint256 blockNumber = block.number;
    if (_stake.lockEnd <= blockNumber) {
      return 0;
    }
    uint256 computationUnits =
      _stake.lockStart > blockNumber ? _stake.oldCUs : computationUnitsAmount(_stake.amount, _stake.duration);
    uint256 epochLength = uint256(router.networkController().epochLength());
    if (_stake.duration <= epochLength) {
      return computationUnits;
    }
    return computationUnits * epochLength / uint256(_stake.duration);
  }

  /**
   * @dev Allocate computation units to workers
   * Allocates i-th amount of cus to the worker with i-ths workerId
   * Sum of all cus should not exceed the amount of available cus
   */
  function allocateComputationUnits(uint256[] calldata workerIds, uint256[] calldata cus) external whenNotPaused {
    require(workerIds.length == cus.length, "Length mismatch");
    Gateway storage gateway = gateways[gatewayByAddress[msg.sender]];
    uint256 newlyAllocated = 0;
    uint256 workerIdCap = router.workerRegistration().nextWorkerId();
    for (uint256 i = 0; i < workerIds.length; i++) {
      require(workerIds[i] < workerIdCap, "Worker does not exist");
      newlyAllocated += cus[i];
    }
    require(newlyAllocated <= 10000, "Over 100% of CUs allocated");

    emit AllocatedCUs(msg.sender, gateway.peerId, workerIds, cus);
  }

  /// @return How much computation units will be allocated for given staked amount and duration
  function computationUnitsAmount(uint256 amount, uint256 durationBlocks) public view returns (uint256) {
    return amount * durationBlocks * mana * router.rewardCalculation().boostFactor(durationBlocks * averageBlockTime)
      / (BASIS_POINT_MULTIPLIER * tokenDecimals * 1000);
  }

  /// @return Amount of tokens staked by the gateway
  function staked(address operator) external view returns (uint256) {
    return operators[operator].stake.amount;
  }

  /// @return Amount of tokens that can be unstaked by the gateway
  function canUnstake(address operator) public view returns (bool) {
    return operators[operator].stake.lockEnd <= block.number;
  }

  /// @return List of all stakes made by the gateway
  function getStake(address operator) external view returns (Stake memory) {
    return operators[operator].stake;
  }

  function getGateway(bytes calldata peerId) external view returns (Gateway memory) {
    return gateways[keccak256(peerId)];
  }

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    return gateways[keccak256(peerId)].metadata;
  }

  /// @dev Get all gateways created by the same wallet as the given gateway
  function getCluster(bytes calldata peerId) external view returns (bytes[] memory clusterPeerIds) {
    (Gateway storage gateway,) = _getGateway(peerId);
    bytes32[] memory hashedIds = operators[gateway.operator].ownedGateways.values();
    clusterPeerIds = new bytes[](hashedIds.length);
    for (uint256 i = 0; i < hashedIds.length; i++) {
      clusterPeerIds[i] = gateways[hashedIds[i]].peerId;
    }
    return clusterPeerIds;
  }

  function setMetadata(bytes calldata peerId, string calldata metadata) external {
    (Gateway storage gateway,) = _getGateway(peerId);
    _requireOperator(gateway);
    gateway.metadata = metadata;

    emit MetadataChanged(msg.sender, peerId, metadata);
  }

  /// @dev Change gateway address. No two gateways should share address. Address can be set to address(0)
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
    gateway.ownAddress = newAddress;

    emit GatewayAddressChanged(msg.sender, peerId, newAddress);
  }

  /// @dev Allow/ban contract to be used by strategy
  /// @notice if isDefault is true, the strategy will be used for all new gateway operators
  function setIsStrategyAllowed(address strategy, bool isAllowed, bool isDefault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!isAllowed && (isDefault || defaultStrategy == strategy)) {
      revert("Cannot set disallowed strategy as default");
    }
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

    emit AverageBlockTimeChanged(_newAverageBlockTime);
  }

  function setMaxGatewaysPerCluster(uint256 _maxGatewaysPerCluster) external onlyRole(DEFAULT_ADMIN_ROLE) {
    maxGatewaysPerCluster = _maxGatewaysPerCluster;

    emit MaxGatewaysPerClusterChanged(_maxGatewaysPerCluster);
  }

  function setMinStake(uint256 _minStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_minStake > 0, "Min stake should not be 0");
    minStake = _minStake;

    emit MinStakeChanged(_minStake);
  }

  function _saturatedDiff(uint128 a, uint128 b) internal pure returns (uint128) {
    if (b >= a) {
      return 0;
    }
    return a - b;
  }

  /**
   * @dev Enable auto extension of the stake
   * If autoextension is enabled, funds would be restaked for the same duration
   */
  function enableAutoExtension() external {
    Stake storage _stake = operators[msg.sender].stake;
    require(!_stake.autoExtension, "AutoExtension enabled");
    _stake.autoExtension = true;
    _stake.lockEnd = type(uint128).max;
    emit AutoextensionEnabled(msg.sender);
  }

  /**
   * @dev Disable auto extension of the stake
   * Tokens will get unlocked after the current lock period ends
   */
  function disableAutoExtension() external {
    Stake storage _stake = operators[msg.sender].stake;
    require(_stake.autoExtension, "AutoExtension disabled");
    _stake.autoExtension = false;
    _stake.lockEnd = _stake.lockStart
      + (_saturatedDiff(uint128(block.number), _stake.lockStart) / _stake.duration + 1) * _stake.duration;

    emit AutoextensionDisabled(msg.sender, _stake.lockEnd);
  }

  function getMyGateways(address operator) external view returns (bytes[] memory) {
    bytes32[] memory ids = operators[operator].ownedGateways.values();
    bytes[] memory peerIds = new bytes[](ids.length);
    for (uint256 i = 0; i < ids.length; i++) {
      peerIds[i] = gateways[ids[i]].peerId;
    }
    return peerIds;
  }

  function getActiveGatewaysCount() external view returns (uint256) {
    return activeGateways.length();
  }

  function getActiveGateways(uint256 pageNumber, uint256 perPage) external view returns (bytes[] memory) {
    bytes32[] memory gatewayIds = activeGateways.values();
    uint256 start = perPage * pageNumber;
    if (start > gatewayIds.length) {
      return new bytes[](0);
    }
    uint256 end = start + perPage;
    if (end > gatewayIds.length) {
      end = gatewayIds.length;
    }
    bytes[] memory peerIds = new bytes[](end - start);
    for (uint256 i = start; i < end; i++) {
      peerIds[i - start] = gateways[gatewayIds[i]].peerId;
    }
    return peerIds;
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
