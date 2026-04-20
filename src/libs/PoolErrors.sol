// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Pool Errors Library
/// @notice Custom error definitions for portal pool contracts
library PoolErrors {
    // State errors
    error InvalidState();
    error PoolPaused();
    error PoolNotFailed();
    error NotActivated();
    error PoolClosed();
    error PoolNotClosed();

    // Stake errors
    error InsufficientStake();
    error InsufficientTransferableStake();
    error CapacityExceeded();
    error ExceedsWalletLimit();
    error NoStakeToWithdraw();
    error InvalidStakeTransfer();

    // Exit queue errors
    error UseWithdrawFromFailed();
    error WaitForActivationOrDeadline();
    error ExistingExitRequest();
    error NoActiveExitRequest();
    error StillInQueue();
    error AlreadyWithdrawn();
    error InvalidExitRate();

    // Deadline errors
    error DeadlinePassed();
    error DeadlineNotPassed();
    error InvalidDeadline();

    // Authorization errors
    error NotOperator();
    error NotFactory();
    error NotPoolRegistry();
    error NotLPTToken();
    error NotAuthorized();
    error NotAdmin();
    error NotWhitelisted();
    error WhitelistFeatureDisabled();

    // Validation errors
    error InvalidAmount();
    error InvalidAddress();
    error AddressAlreadySet();
    error BelowMinimum();
    error AboveMaximum();
    error BelowCurrentStake();
    error NoChange();
    error CapacityOutOfRange();
    error EmptyPeerId();

    // Token errors
    error TokenNotAllowed();
    error TooManyTokens();
    error AlreadyInitialized();
    error TokenAlreadyAdded();
    error NoPaymentTokens();
    error NothingToClaim();
    error InvalidDecimals();
    error InvalidTokenConfig();

    // Distribution errors
    error DistributionTurnedOff();
    error PoolHasDebt();
    error RateExceedsMaximum();
    error RateBelowMinimum();
    error InsufficientRewardPrecision();

    // Factory errors
    error InvalidPool();
    error InvalidRange();

    // Fee router errors
    error InvalidFeeConfig();
    error InvalidPoolFee();
    error NothingToBuyback();
    error BuybackDisabled();
    error SlippageProtectionNotConfigured();
}
