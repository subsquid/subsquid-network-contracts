// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPortalRegistry} from "../interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "../interfaces/IFeeRouter.sol";
import {INetworkController} from "../interfaces/INetworkController.sol";
import {IPortalFactory} from "../interfaces/IPortalFactory.sol";
import {IPortalPool} from "../interfaces/IPortalPool.sol";
import {LiquidPortalToken} from "../LiquidPortalToken.sol";
import {ExitQueueLib} from "../libs/ExitQueueLib.sol";
import {Constants} from "../libs/Constants.sol";

abstract contract PortalPoolStorage {
    uint256 public constant PRECISION = Constants.PRECISION;

    IPortalPool.PortalInfo internal _portalInfo;
    bytes internal _peerId;

    mapping(address => uint256) internal _stakes;

    mapping(address => uint256) internal _exitAmounts;
    uint256 internal _totalExitAmounts;

    mapping(address => uint256) internal _cumulativeFeesPerShare;
    mapping(address => uint256) public totalFeesDistributed;
    mapping(address => uint256) public lastDistributionTime;
    mapping(address => mapping(address => uint256)) internal _providerTotalClaimed;

    IERC20 internal _sqd;
    IPortalRegistry internal _portalRegistry;
    IFeeRouter internal _feeRouter;
    INetworkController internal _networkController;
    IPortalFactory internal _factory;

    IERC20 internal _usdc;

    /// @notice provider's available credit (funds available for distribution)
    uint256 public credit;
    /// @notice provider's accumulated debt (owed but unpaid rewards)
    uint256 public debt;
    /// @notice timestamp of last balance checkpoint
    uint64 public balanceTs;
    /// @notice global reward per stake accumulator (scaled by ACC)
    uint256 public rewardPerStakeStored;
    /// @notice timestamp when rewards were last effectively accrued (stays at runway when dry)
    uint64 public lastEffectiveRewardTs;

    /// @notice total distribution rate per second (delegators + treasury)
    uint256 public totalDistributionRatePerSec;
    /// @notice delegator portion of rate (50% of total)
    uint256 public delegatorRatePerSec;
    /// @notice treasury portion of rate (50% of total)
    uint256 public treasuryRatePerSec;
    /// @notice per-stake rate = delegatorRate * ACC / capacity
    uint256 public perStakeRateWad;
    /// @notice treasury accumulated rewards
    uint256 public treasuryAccumulated;

    /// @notice per-user reward debt (stake * RPS / ACC at last update)
    mapping(address => uint256) internal _rewardDebt;
    /// @notice Per-user unclaimed rewards
    mapping(address => uint256) internal _unclaimedRewards;

    // legacy fields (kept for storage layout compatibility)
    uint256 internal _legacy_distributionRateScaled;
    uint256 internal _legacy_lastRewardBalanceScaled;
    uint256 internal _legacy_lastRewardTimestamp;
    uint256 internal _legacy_lastEffectiveRewardTimestamp;
    mapping(address => IPortalPool.DelegatorCheckpoint) internal _legacy_delegatorCheckpoints;

    ExitQueueLib.Queue internal _exitQueue;

    mapping(address => mapping(uint256 => ExitQueueLib.Ticket)) internal _exitTickets;
    mapping(address => uint256) internal _nextTicketId;

    LiquidPortalToken public lptToken;

    mapping(address => mapping(address => uint256)) internal _feeDebt;
    mapping(address => mapping(address => uint256)) internal _unclaimedFees;

    address public workerPoolAddress;
    address public burnAddress;

    uint256[50] private __gap;
}
