// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library GatewayErrors {
    error InvalidAddress();
    error PortalNotRegistered();
    error PortalAlreadyRegistered();
    error PeerIdInUse();
    error OnlyPortal();
    error InsufficientAllocation();
    error NoUnlockRequest();
    error NothingToWithdraw();
}
