// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IFeeRouter Interface
/// @notice Interface for fee distribution between providers, worker pool, and burn
interface IFeeRouter {
    struct FeeConfig {
        uint16 toProvidersBPS;
        uint16 toWorkerPoolBPS;
        uint16 toBurnBPS;
    }

    event FeeConfigUpdated(uint16 toProviders, uint16 toWorkerPool, uint16 toBurn);
    event BurnAddressUpdated(address burnAddress);
    event WorkerPoolAddressUpdated(address workerPoolAddress);
    event RoutedToWorkerPool(address indexed from, address indexed rewardToken, uint256 amount);
    event RoutedToBurn(address indexed from, address indexed rewardToken, uint256 amount);

    function calculateSplit(uint256 amount)
        external
        view
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn);

    function setFeeConfig(uint16 toProvidersBPS, uint16 toWorkerPoolBPS, uint16 toBurnBPS) external;

    function getFeeConfig() external view returns (FeeConfig memory);

    function setBurnAddress(address newBurnAddress) external;

    function getBurnAddress() external view returns (address);

    /// @notice Sets the worker pool address
    function setWorkerPoolAddress(address workerPool) external;

    /// @notice Returns the worker pool address
    function getWorkerPoolAddress() external view returns (address);

    /// @notice Routes tokens from caller to worker pool
    /// @dev Caller must approve this contract first
    function routeToWorkerPool(address rewardToken, uint256 amount) external;

    /// @notice Routes tokens from caller to burn (may trigger buyback in V2)
    /// @dev Caller must approve this contract first
    function routeToBurn(address rewardToken, uint256 amount) external;
}
