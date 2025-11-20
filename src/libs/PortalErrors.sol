// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library PortalErrors {
    error InvalidState();
    error InsufficientStake();
    error DeadlinePassed();
    error NotOperator();
    error PortalPaused();
    error InvalidAmount();
    error NotFactory();
    error CapacityExceeded();
    error NotGatewayRegistry();
    error PortalNotFailed();
    error NoStakeToWithdraw();
    error TokenNotAllowed();
}

