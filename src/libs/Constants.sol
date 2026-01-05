// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Constants library for Portal contracts
library Constants {
    /// @notice precision multiplier for reward calculations (1e18)
    uint256 internal constant PRECISION = 1e27;

    /// @notice basis points denominator (10000 = 100%)
    uint256 internal constant BASIS_POINTS = 10_000;

    /// @notice maximum number of payment tokens allowed per portal
    uint256 internal constant MAX_PAYMENT_TOKENS = 10;

    /// @notice default rate at which exit queue unlocks SQD per second (1 SQD/second)
    uint256 internal constant EXIT_UNLOCK_RATE_PER_SECOND = 1e18;

    /// @notice fee precision for cumulative fee calculations
    uint256 internal constant FEE_PRECISION = 1e27;

    /// @notice fixed collection deadline for portal pools (30 days)
    /// @dev pools must reach capacity within this time or fail
    uint256 internal constant COLLECTION_DEADLINE_SECONDS = 30 days;

    /// @notice maximum distribution rate per second (1000 USDC/sec = $86.4M/day)
    /// @dev protects against misconfigured rate scale (e.g., 18 decimals instead of 6)
    /// @dev this value is already scaled by RATE_PRECISION
    uint256 internal constant MAX_DISTRIBUTION_RATE_PER_SECOND = 1e12;

    /// @notice minimum distribution rate per second (scaled)
    /// @dev ensures meaningful precision for calculations (e.g., $50/month scenarios)
    /// @dev 1000 = 1 token/second minimum after RATE_PRECISION scaling
    uint256 internal constant MIN_DISTRIBUTION_RATE_PER_SECOND = 1000;

    /// @notice precision multiplier for distribution rates
    /// @dev allows rates as low as 0.001 tokens per second (e.g., 1 = 0.001/sec, 1000 = 1/sec)
    /// @dev rate of 1 token/sec should be passed as 1000
    uint256 internal constant RATE_PRECISION = 1000;
}
