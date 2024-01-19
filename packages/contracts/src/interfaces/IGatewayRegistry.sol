pragma solidity 0.8.20;
interface IGatewayRegistry {
  function computationUnitsAvailable(bytes calldata gateway) external view returns (uint256);
}

