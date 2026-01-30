// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PancakeSwap V3 Router Interface (Minimal)
/// @notice Minimal interface for executing swaps on PancakeSwap V3
/// @dev Based on PancakeSwap's IV3SwapRouter - only includes what we need for buybacks
interface IPancakeV3Router {
    /// @notice Parameters for single-hop exact input swap
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another token
    /// @param params The parameters necessary for the swap
    /// @return amountOut The amount of the received token
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /// @notice Parameters for multi-hop exact input swap
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another along the specified path
    /// @param params The parameters necessary for the multi-hop swap
    /// @return amountOut The amount of the received token
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
