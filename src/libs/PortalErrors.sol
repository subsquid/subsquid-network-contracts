// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library PortalErrors {
    // State errors
    error InvalidState();
    error PortalPaused();
    error PortalNotFailed();
    error NotActivated();

    // Stake errors
    error InsufficientStake();
    error InsufficientTransferableStake();
    error CapacityExceeded();
    error ExceedsWalletLimit();
    error NoStakeToWithdraw();

    // Exit queue errors
    error UseWithdrawFromFailed();
    error WaitForActivationOrDeadline();
    error ExistingExitRequest();
    error NoActiveExitRequest();
    error StillInQueue();
    error AlreadyWithdrawn();

    // Deadline errors
    error DeadlinePassed();
    error DeadlineNotPassed();
    error InvalidDeadline();

    // Authorization errors
    error NotOperator();
    error NotFactory();
    error NotPortalRegistry();
    error NotLPTToken();
    error NotAuthorized();

    // Validation errors
    error InvalidAmount();
    error InvalidAddress();
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

    // Distribution errors
    error DistributionTurnedOff();
    error PoolHasDebt();

    // Factory errors
    error InvalidPortal();
    error InvalidRange();

    // Fee router errors
    error InvalidFeeConfig();
}
