// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPortalPool Interface
/// @notice Interface for the portal pool implementation contract
interface IPortalPool {
    enum PoolState {
        COLLECTING,
        ACTIVE,
        IDLE,
        FAILED,
        CLOSED
    }

    struct PoolInfo {
        address operator;
        uint256 capacity;
        uint256 totalStaked;
        uint64 depositDeadline;
        uint64 activationTime;
        PoolState state;
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
        string tokenSuffix;
        address sqd;
        address rewardToken;
        address portalRegistry;
        address feeRouter;
        uint256 minStakeThreshold;
        uint256 distributionRatePerSecond;
        string metadata;
    }

    event Deposited(address indexed provider, uint256 amount, uint256 newTotal);
    event ExitRequested(address indexed provider, uint256 amount, uint256 endPosition);
    event ExitClaimed(address indexed provider, uint256 amount);
    event Withdrawn(address indexed provider, uint256 amount);
    event StateChanged(PoolState oldState, PoolState newState);
    event StakeTransferred(address indexed from, address indexed to, uint256 amount);
    event RewardsToppedUp(
        address indexed operator, uint256 received, uint256 toProviders, uint256 toWorkerPool, uint256 toBurn
    );
    event RewardsClaimed(address indexed delegator, uint256 amount);
    event DistributionRateChanged(uint256 oldRate, uint256 newRate);
    event CapacityUpdated(uint256 oldCapacity, uint256 newCapacity);
    event WhitelistEnabledChanged(bool enabled);
    event WhitelistUpdated(address indexed user, bool added);
    event PoolClosed(address indexed closedBy, uint256 timestamp);
    event RewardsRecovered(address indexed operator, uint256 amount);

    function initialize(InitParams calldata params) external;

    function deposit(uint256 amount) external;
    function requestExit(uint256 amount) external returns (uint256 ticketId);
    function withdrawExit(uint256 ticketId) external;
    function onLPTTransfer(address from, address to, uint256 amount) external;
    function withdrawFromFailed() external;
    function recoverRewardsFromFailed() external returns (uint256);

    function topUpRewards(uint256 amount) external;
    function initializeCredit(uint256 amount) external;
    function claimRewards() external returns (uint256);
    function setDistributionRate(uint256 newRatePerSecond) external;
    function setCapacity(uint256 newCapacity) external;

    function getPoolInfo() external view returns (PoolInfo memory);
    function getProviderStake(address provider) external view returns (uint256);
    function getExitTicket(address provider, uint256 ticketId) external view returns (ExitTicket memory);
    function getTicketCount(address provider) external view returns (uint256);
    function getClaimableRewards(address delegator) external view returns (uint256);
    function getRewardToken() external view returns (address);
    function getCurrentRewardBalance() external view returns (int256);
    function getRewardStatus()
        external
        view
        returns (int256 balance, uint256 currentDebt, int256 runwayTimestamp, bool isDry);
    function getCredit() external view returns (uint256);
    function getDebt() external view returns (uint256);
    function isOutOfMoney() external view returns (bool);
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
    function getTotalDrainRate() external view returns (uint256);
    function getRunway() external view returns (int256);
    function getActiveStake() external view returns (uint256);
    function getComputationUnits() external view returns (uint256);
    function getState() external view returns (PoolState);
    function getQueueStatus(address user, uint256 ticketId)
        external
        view
        returns (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready);

    function getQueueStatusWithTimestamp(address user, uint256 ticketId)
        external
        view
        returns (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready, uint256 unlockTimestamp);
    function getTotalProcessed() external view returns (uint256);
    function getMetadata() external view returns (string memory);
    function getMinCapacity() external view returns (uint256);
    function getWithdrawalWaitingTimestamp(uint256 amount) external view returns (uint256 unlockTimestamp);

    function pause() external;
    function unpause() external;

    function closePool() external;
    function emergencyWithdraw() external;

    function setWhitelistEnabled(bool enabled) external;
    function addToWhitelist(address[] calldata users) external;
    function removeFromWhitelist(address[] calldata users) external;
    function isWhitelisted(address user) external view returns (bool);
}
