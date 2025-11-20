// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPortal {
    
    enum PortalState {
        COLLECTING,
        ACTIVE,
        SUNSET,
        FAILED
    }
    
    struct PortalInfo {
        address operator;
        uint96 maxCapacity;
        uint96 totalStaked;
        uint64 depositDeadline;
        uint64 activationTime;
        PortalState state;
        bool paused;
    }

    struct ExitRequest {
        uint128 amount;
        uint64 requestEpoch;
        uint64 unlockEpoch;
    }

    event Staked(address indexed provider, uint256 amount, uint256 newTotal);
    event ExitRequested(address indexed provider, uint256 amount, uint256 unlockEpoch);
    event Withdrawn(address indexed provider, uint256 amount);
    event FeesDistributed(address indexed token, uint256 totalAmount, uint256 toProviders, uint256 toWorkers, uint256 toBurn);
    event FeesClaimed(address indexed provider, address indexed token, uint256 amount);
    event StateChanged(PortalState oldState, PortalState newState);
    event AllocationReduced(address indexed provider, uint256 amount);
    event PaymentTokensInitialized(address[] paymentTokens);

    function initialize(
        address operator,
        uint256 maxCapacity,
        uint256 depositDeadline,
        bytes calldata peerId,
        address sqd,
        address gatewayRegistry,
        address feeRouter,
        address networkController
    ) external;
    
    function initializePaymentTokens(address[] calldata paymentTokens) external;
    
    function stake(uint256 amount) external;
    function activate() external;
    function requestExit(uint256 amount) external;
    function onAllocationReduced(address provider, uint256 amount) external;
    function withdrawForMove(address provider, uint256 amount) external;
    function depositFromMove(address provider, uint256 amount) external;
    function distributeFees(address token, uint256 amount) external;
    function claimFees(address token) external returns (uint256);
    
    function getPortalInfo() external view returns (PortalInfo memory);
    function getProviderStake(address provider) external view returns (uint256);
    function getExitRequest(address provider) external view returns (ExitRequest memory);
    function getClaimableFees(address provider, address token) external view returns (uint256);
    function getPeerId() external view returns (bytes memory);
    function getCurrentAPY(address token) external view returns (uint256);
    function getAllowedPaymentTokens() external view returns (address[] memory);
    
    function pause() external;
    function unpause() external;
    function upgradeTo(address newImplementation) external;
}
