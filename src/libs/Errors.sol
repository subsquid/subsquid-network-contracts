// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library Errors {
    error InvalidState();
    error NotConsumer();
    error NotFactory();
    error DeadlineNotReached();
    error TargetNotMet();
    error PastDeadline();
    error NothingToClaim();
    error AlreadyInitialized();
    error ZeroAmount();
    error InvalidAddress();
    error ZeroAddress();
    error InvalidCaller();
    error InvalidSplit();
    error InvalidParameters();
    error InvalidDeadline();
    error UnsupportedPaymentToken();
    error MinimumDurationNotMet();

    error InsufficientBalance();
    error BelowMinimumDeposit();
    error ExceedsMaximumDeposit();
    error ExitStillLocked();
    error GatewayStakeFailed();
    error GatewayUnstakeFailed();
    error InvalidEpochLength();

    error StakeAlreadyExists();
    error DurationTooShort();
    error NothingToUnstake();
    error StakeIsLocked();
    error NoExistingStake();
}
