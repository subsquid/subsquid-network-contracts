// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Portal Registry Errors Library
/// @notice Custom error definitions for the portal registry contract
library PortalRegistryErrors {
    error InvalidAddress();
    error InvalidPeerId();
    error InvalidPortalIndex();
    error ClusterAlreadyRegistered();
    error ClusterNotRegistered();
    error MaxClustersReached();
    error MaxPortalsReached();
    error PeerIdInUse();
    error OnlyFactory();
    error NotClusterOperator();
    error InsufficientAllocation();
}
