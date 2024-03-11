pragma solidity 0.8.20;

interface IGatewayRegistry {
  struct Stake {
    uint256 amount;
    uint128 lockStart;
    uint128 lockEnd;
    uint128 duration;
    bool autoExtension;
    uint256 oldCUs;
  }

  struct Gateway {
    address operator;
    address ownAddress;
    bytes peerId;
    string metadata;
  }

  event Registered(address indexed gatewayOperator, bytes32 indexed id, bytes peerId);
  event Staked(
    address indexed gatewayOperator, uint256 amount, uint128 lockStart, uint128 lockEnd, uint256 computationUnits
  );
  event Unstaked(address indexed gatewayOperator, uint256 amount);
  event Unregistered(address indexed gatewayOperator, bytes peerId);

  event AllocatedCUs(address indexed gateway, bytes peerId, uint256[] workerIds, uint256[] shares);

  event StrategyAllowed(address indexed strategy, bool isAllowed);
  event DefaultStrategyChanged(address indexed strategy);
  event ManaChanged(uint256 newCuPerSQD);
  event MaxGatewaysPerClusterChanged(uint256 newAmount);

  event MetadataChanged(address indexed gatewayOperator, bytes peerId, string metadata);
  event GatewayAddressChanged(address indexed gatewayOperator, bytes peerId, address newAddress);
  event UsedStrategyChanged(address indexed gatewayOperator, address strategy);
  event AutoextensionEnabled(address indexed gatewayOperator);
  event AutoextensionDisabled(address indexed gatewayOperator, uint128 lockEnd);

  event AverageBlockTimeChanged(uint256 newBlockTime);

  function computationUnitsAvailable(bytes calldata gateway) external view returns (uint256);
}
