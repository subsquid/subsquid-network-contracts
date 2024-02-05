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
  using EnumerableSet for EnumerableSet.Bytes32Set;

  uint256 constant BASIS_POINT_MULTIPLIER = 10000;

  struct Stake {
    uint256 amount;
    uint256 computationUnits;
    uint128 lockStart;
    uint128 lockEnd;
    uint128 duration;
  }

  struct Gateway {
    address operator;
    address ownAddress;
    bytes peerId;
    string metadata;
  }

  struct GatewayOperator {
    bool previousInteractions;
    address strategy;
    uint256 totalStaked;
    uint256 totalUnstaked;
    Stake[] stakes;
    EnumerableSet.Bytes32Set ownedGateways;
  }

  IERC20WithMetadata public immutable token;
  IRouter public immutable router;
  mapping(bytes32 gatewayId => Gateway gateway) gateways;
  mapping(address operator => GatewayOperator) internal operators;
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
    uint256 stakeIndex,
    uint256 amount,
    uint128 lockStart,
    uint128 lockEnd,
    uint256 computationUnits
  );
  event Unstaked(address indexed gatewayOperator, uint256 amount);
  event Unregistered(address indexed gatewayOperator, bytes peerId);

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] shares);

  event StrategyAllowed(address indexed strategy, bool isAllowed);
  event DefaultStrategyChanged(address indexed strategy);
  event ManaChanged(uint256 newCuPerSQD);

  event MetadataChanged(address indexed gatewayOperator, bytes peerId, string metadata);
  event GatewayAddressChanged(address indexed gatewayOperator, bytes peerId, address newAddress);
  event UsedStrategyChanged(address indexed gatewayOperator, address strategy);
  event AutoextensionEnabled(address indexed gatewayOperator, uint256 indexed stakeIndex);
  event AutoextensionDisabled(address indexed gatewayOperator, uint256 indexed stakeIndex, uint128 lockEnd);

  event AverageBlockTimeChanged(uint256 newBlockTime);

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

  function register(bytes[] calldata peerId, string[] calldata metadata, address[] calldata gatewayAddress) external {
    require(peerId.length == metadata.length, "Length mismatch");
    require(peerId.length == gatewayAddress.length, "Length mismatch");
    for (uint256 i = 0; i < peerId.length; i++) {
      register(peerId[i], metadata[i], gatewayAddress[i]);
    }
  }

  /// @dev Register new gateway with given libP2P peerId
  function register(bytes calldata peerId, string memory metadata, address gatewayAddress) public whenNotPaused {
    require(peerId.length > 0, "Cannot set empty peerId");
    bytes32 peerIdHash = keccak256(peerId);
    require(gateways[peerIdHash].operator == address(0), "PeerId already registered");
    if (!operators[msg.sender].previousInteractions) {
      useStrategy(defaultStrategy);
    }
    gateways[peerIdHash] =
      Gateway({operator: msg.sender, ownAddress: gatewayAddress, peerId: peerId, metadata: metadata});
    operators[msg.sender].ownedGateways.add(peerIdHash);

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
  function stake(uint256 amount, uint128 durationBlocks, bool withAutoExtension) public whenNotPaused {
    uint256 _computationUnits = computationUnitsAmount(amount, durationBlocks);
    uint128 lockStart = router.networkController().nextEpoch();
    uint128 lockEnd = withAutoExtension ? type(uint128).max : lockStart + durationBlocks;
    operators[msg.sender].stakes.push(Stake(amount, _computationUnits, lockStart, lockEnd, durationBlocks));
    operators[msg.sender].totalStaked += amount;
    token.transferFrom(msg.sender, address(this), amount);

    emit Staked(msg.sender, operators[msg.sender].stakes.length - 1, amount, lockStart, lockEnd, _computationUnits);
  }

  function stake(uint256 amount, uint128 durationBlocks) external {
    stake(amount, durationBlocks, false);
  }

  /// @dev Unstake tokens. Only tokens past the lock period can be unstaked
  function unstake(uint256 amount) external whenNotPaused {
    require(amount <= unstakeable(msg.sender), "Not enough funds to unstake");
    operators[msg.sender].totalUnstaked += amount;
    token.transfer(msg.sender, amount);

    emit Unstaked(msg.sender, amount);
  }

  /// @dev The default strategy used is address(0) which is a manual allocation submitting
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

    Stake[] memory _stakes = operators[gateway.operator].stakes;
    uint256 total = 0;
    uint256 blockNumber = block.number;
    uint256 epochLength = uint256(router.networkController().epochLength());
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockStart <= blockNumber && _stake.lockEnd > blockNumber) {
        if (_stake.duration <= epochLength) {
          return _stake.computationUnits;
        }
        total += _stake.computationUnits * epochLength / uint256(_stake.duration);
      }
    }
    return total;
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
    return operators[operator].totalStaked - operators[operator].totalUnstaked;
  }

  /// @return Amount of tokens that can be unstaked by the gateway
  function unstakeable(address operator) public view returns (uint256) {
    Stake[] memory _stakes = operators[operator].stakes;
    uint256 blockNumber = block.number;
    uint256 total = 0;
    for (uint256 i = 0; i < _stakes.length; i++) {
      Stake memory _stake = _stakes[i];
      if (_stake.lockEnd <= blockNumber) {
        total += _stake.amount;
      }
    }
    return total - operators[operator].totalUnstaked;
  }

  //  /// @return List of all stakes made by the gateway
  function getStakes(address operator) external view returns (Stake[] memory) {
    return operators[operator].stakes;
  }

  function getGateway(bytes calldata peerId) external view returns (Gateway memory) {
    return gateways[keccak256(peerId)];
  }

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    return gateways[keccak256(peerId)].metadata;
  }

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

  function _saturatedDiff(uint128 a, uint128 b) internal pure returns (uint128) {
    if (b >= a) {
      return 0;
    }
    return a - b;
  }

  function disableAutoExtension(uint256 index) external {
    Stake storage _stake = operators[msg.sender].stakes[index];
    require(_stake.lockEnd == type(uint128).max, "AutoExtension disabled");
    _stake.lockEnd = _stake.lockStart
      + (_saturatedDiff(uint128(block.number), _stake.lockStart) / _stake.duration + 1) * _stake.duration;

    emit AutoextensionDisabled(msg.sender, index, _stake.lockEnd);
  }

  function disableAllAutoExtensions() external {
    Stake[] storage stakes = operators[msg.sender].stakes;
    uint128 blockNumber = uint128(block.number);
    for (uint256 i = 0; i < stakes.length; i++) {
      Stake storage _stake = stakes[i];
      if (_stake.lockEnd != type(uint128).max) {
        continue;
      }
      _stake.lockEnd =
        _stake.lockStart + (_saturatedDiff(blockNumber, _stake.lockStart) / _stake.duration + 1) * _stake.duration;
      emit AutoextensionDisabled(msg.sender, i, _stake.lockEnd);
    }
  }

  function enableAutoExtension(uint256 index) external {
    operators[msg.sender].stakes[index].lockEnd = type(uint128).max;
    emit AutoextensionEnabled(msg.sender, index);
  }

  function enableAllAutoExtensions() external {
    Stake[] storage stakes = operators[msg.sender].stakes;
    for (uint256 i = 0; i < stakes.length; i++) {
      stakes[i].lockEnd = type(uint128).max;
      emit AutoextensionEnabled(msg.sender, i);
    }
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
