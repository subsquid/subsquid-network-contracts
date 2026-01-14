// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFeeRouter} from "./IFeeRouter.sol";

/// @title IFeeRouterV2 Interface
/// @notice Extended fee router interface with buyback functionality
interface IFeeRouterV2 is IFeeRouter {
    /// @notice Routes fees with automatic SQD buyback for the burn portion
    /// @param rewardToken The reward token being distributed (e.g., USDC)
    /// @param amount The total amount to route
    /// @param workerPoolAddress Where to send the worker pool portion
    /// @param minSqdOut Minimum SQD to receive from buyback (0 = use default slippage)
    /// @return toProviders Amount returned to pool for provider distribution
    /// @return toWorkerPool Amount sent to worker pool
    /// @return sqdBought Amount of SQD bought and burned (0 if buyback skipped)
    function routeFeesWithBuyback(
        address rewardToken,
        uint256 amount,
        address workerPoolAddress,
        uint256 minSqdOut
    ) external returns (uint256 toProviders, uint256 toWorkerPool, uint256 sqdBought);

    /// @notice Configures buyback parameters
    /// @param pancakeRouter PancakeSwap V3 SmartRouter address
    /// @param sqd SQD token address
    /// @param poolFee Pool fee tier (100, 500, 2500, or 10000)
    /// @param slippageBPS Maximum slippage in basis points
    /// @param minBuybackThreshold Minimum amount to trigger buyback
    function configureBuyback(
        address pancakeRouter,
        address sqd,
        uint24 poolFee,
        uint16 slippageBPS,
        uint256 minBuybackThreshold
    ) external;

    /// @notice Enables or disables buyback functionality
    function setBuybackEnabled(bool enabled) external;

    /// @notice Returns current buyback configuration
    function getBuybackConfig()
        external
        view
        returns (
            address router,
            address sqdToken,
            uint24 fee,
            uint16 slippage,
            uint256 minThreshold,
            bool enabled
        );

    /// @notice Emitted when a buyback is executed
    event BuybackExecuted(
        address indexed rewardToken,
        uint256 amountIn,
        uint256 sqdBought,
        address indexed recipient
    );

    /// @notice Emitted when buyback config is updated
    event BuybackConfigUpdated(
        address indexed pancakeRouter,
        address indexed sqd,
        uint24 poolFee,
        uint16 slippageBPS,
        uint256 minBuybackThreshold
    );

    /// @notice Emitted when buyback is enabled/disabled
    event BuybackEnabledChanged(bool enabled);

    /// @notice Emitted when buyback is skipped
    event BuybackSkipped(uint256 amount, string reason);
}
