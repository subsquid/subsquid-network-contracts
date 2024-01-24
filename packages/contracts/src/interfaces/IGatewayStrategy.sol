pragma solidity 0.8.20;

interface IGatewayStrategy {
  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256 workerId) external view returns (uint256);
}
