// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Constants library for Portal contracts
library Constants {
    /// @notice precision multiplier for reward calculations (1e18)
    uint256 internal constant PRECISION = 1e18;

    /// @notice basis points denominator (10000 = 100%)
    uint256 internal constant BASIS_POINTS = 10_000;

    /// @notice maximum number of payment tokens allowed per portal
    uint256 internal constant MAX_PAYMENT_TOKENS = 10;

    /// @notice default rate at which exit queue unlocks SQD per second (1 SQD/second)
    uint256 internal constant EXIT_UNLOCK_RATE_PER_SECOND = 1e18;

    /// @notice fee precision for cumulative fee calculations
    uint256 internal constant FEE_PRECISION = 1e18;

    /// @notice fixed collection deadline for portal pools (30 days)
    /// @dev pools must reach capacity within this time or fail
    uint256 internal constant COLLECTION_DEADLINE_SECONDS = 30 days;
}
