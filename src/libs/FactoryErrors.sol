// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library FactoryErrors {
    error InvalidAddress();
    error InvalidPortal();
    error InvalidRange();
    error NoPaymentTokens();
    error BelowMinimum();
    error InvalidDeadline();
    error EmptyPeerId();
}
