// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Constants library for Portal contracts
library Constants {
    /// @notice precision multiplier for reward calculations (1e27)
    uint256 internal constant PRECISION = 1e27;

    /// @notice basis points denominator (10000 = 100%)
    uint256 internal constant BASIS_POINTS = 10_000;

    /// @notice maximum number of payment tokens allowed per portal
    uint256 internal constant MAX_PAYMENT_TOKENS = 10;

    /// @notice maximum distribution rate per second
    /// @dev Supports 18-decimal tokens (ETH, DAI, SQD) up to ~2.6 trillion tokens/month
    /// @dev For 6-decimal tokens (USDC), allows up to ~$2.6 quadrillion/month
    /// @dev this value is already scaled by RATE_PRECISION
    uint256 internal constant MAX_DISTRIBUTION_RATE_PER_SECOND = 1e27;

    /// @notice minimum distribution rate per second (scaled)
    /// @dev ensures meaningful precision for calculations (e.g., $50/month scenarios)
    /// @dev 1000 = 1 token/second minimum after RATE_PRECISION scaling
    uint256 internal constant MIN_DISTRIBUTION_RATE_PER_SECOND = 1000;

    /// @notice precision multiplier for distribution rates
    /// @dev allows rates as low as 0.001 tokens per second (e.g., 1 = 0.001/sec, 1000 = 1/sec)
    /// @dev rate of 1 token/sec should be passed as 1000
    uint256 internal constant RATE_PRECISION = 1000;

    /// @notice minimum per-stake rate to prevent precision loss in reward calculations
    /// @dev ensures (rate * PRECISION) / (capacity * RATE_PRECISION) >= MIN_PER_STAKE_RATE
    /// @dev equivalent to requiring capacity / rate <= 1e12
    uint256 internal constant MIN_PER_STAKE_RATE = 1e12;
}
