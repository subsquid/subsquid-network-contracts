// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library PortalRegistryErrors {
    error InvalidAddress();
    error InvalidPeerId();
    error PortalAlreadyRegistered();
    error PortalNotRegistered();
    error PeerIdInUse();
    error OnlyPortal();
    error OnlyOperator();
    error NotOperator();
    error InsufficientAllocation();
    error AlreadyHasDirectPortal();
    error NoDirectPortal();
    error NotDirectPortal();
    error NotPoolPortal();
    error OnlyPoolPortal();
    error InvalidAmount();
}
