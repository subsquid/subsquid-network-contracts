// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPortalPool {
    enum PortalState {
        COLLECTING,
        ACTIVE,
        IDLE,
        FAILED
    }

    struct PortalInfo {
        address operator;
        uint256 capacity;
        uint256 totalStaked;
        uint64 depositDeadline;
        uint64 activationTime;
        PortalState state;
        bool paused;
        bool firstActivated;
    }

    struct ExitTicket {
        uint256 endPosition;
        uint256 amount;
        bool withdrawn;
    }

    struct DelegatorCheckpoint {
        uint256 lastClaimedBalanceScaled;
        uint256 lastTimestamp;
    }

    struct InitParams {
        address operator;
        uint256 capacity;
        uint256 depositDeadline;
        bytes peerId;
        string tokenSuffix;
        address sqd;
        address usdc;
        address portalRegistry;
        address feeRouter;
        address networkController;
        uint256 distributionRatePerSecond;
        string metadata;
    }

    event Deposited(address indexed provider, uint256 amount, uint256 newTotal);
    event ExitRequested(address indexed provider, uint256 amount, uint256 endPosition);
    event ExitClaimed(address indexed provider, uint256 amount);
    event Withdrawn(address indexed provider, uint256 amount);
    event FeesDistributed(
        address indexed token, uint256 totalAmount, uint256 toProviders, uint256 toWorkers, uint256 toBurn
    );
    event BurnAddressUpdated(address burnAddress);
    event FeesClaimed(address indexed provider, address indexed token, uint256 amount);
    event StateChanged(PortalState oldState, PortalState newState);
    event AllocationReduced(address indexed provider, uint256 amount);
    event StakeTransferred(address indexed from, address indexed to, uint256 amount);
    event RewardsToppedUp(address indexed operator, uint256 amount, uint256 newBalanceScaled);
    event RewardsClaimed(address indexed delegator, uint256 amount);
    event DistributionRateChanged(uint256 oldRate, uint256 newRate);
    event CapacityUpdated(uint256 oldCapacity, uint256 newCapacity);

    function initialize(InitParams calldata params) external;

    function deposit(uint256 amount) external;
    function requestExit(uint256 amount) external returns (uint256 ticketId);
    function withdrawExit(uint256 ticketId) external;
    function onAllocationReduced(address provider, uint256 amount) external;
    function onLPTTransfer(address from, address to, uint256 amount) external;
    function distributeFees(address token, uint256 amount) external;
    function claimFees(address token) external returns (uint256);
    function withdrawFromFailed() external;

    function topUpRewards(uint256 amount) external;
    function claimRewards() external returns (uint256);
    function setDistributionRate(uint256 newRatePerSecond) external;
    function setCapacity(uint256 newCapacity) external;
    function setBurnAddress(address newBurnAddress) external;

    function getPortalInfo() external view returns (PortalInfo memory);
    function getProviderStake(address provider) external view returns (uint256);
    function getExitTicket(address provider, uint256 ticketId) external view returns (ExitTicket memory);
    function getTicketCount(address provider) external view returns (uint256);
    function getClaimableFees(address provider, address token) external view returns (uint256);
    function getClaimableRewards(address delegator) external view returns (uint256);
    function getCurrentRewardBalance() external view returns (int256);
    function getRewardStatus()
        external
        view
        returns (int256 balance, uint256 currentDebt, int256 runwayTimestamp, bool isDry);
    function getCredit() external view returns (uint256);
    function getDebt() external view returns (uint256);
    function isOutOfMoney() external view returns (bool);
    function getUserRewards(address user) external view returns (uint256);
    function getPoolStatusWithRewards(address user)
        external
        view
        returns (
            uint256 poolCredit,
            uint256 poolDebt,
            int256 poolBalance,
            int256 runway,
            bool outOfMoney,
            uint256 userRewards,
            uint256 userStake
        );
    function getRewardDebt() external view returns (uint256);
    function getTotalDrainRate() external view returns (uint256);
    function getRunway() external view returns (int256);
    function getPeerId() external view returns (bytes memory);
    function getActiveStake() external view returns (uint256);
    function getComputationUnits() external view returns (uint256);
    function getAllowedPaymentTokens() external view returns (address[] memory);
    function getState() external view returns (PortalState);
    function getQueueStatus(address user, uint256 ticketId)
        external
        view
        returns (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready);

    function getQueueStatusWithTimestamp(address user, uint256 ticketId)
        external
        view
        returns (
            uint256 processed,
            uint256 userEndPos,
            uint256 secondsRemaining,
            bool ready,
            uint256 unlockTimestamp
        );
    function getTotalProcessed() external view returns (uint256);
    function getMetadata() external view returns (string memory);
    function getMinCapacity() external view returns (uint256);

    function pause() external;
    function unpause() external;
}
