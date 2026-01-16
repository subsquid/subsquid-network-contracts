// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPortalRegistry} from "../interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "../interfaces/IFeeRouter.sol";
import {IPortalFactory} from "../interfaces/IPortalFactory.sol";
import {IPortalPool} from "../interfaces/IPortalPool.sol";
import {LiquidPortalToken} from "../LiquidPortalToken.sol";
import {ExitQueueLib} from "../libs/ExitQueueLib.sol";
import {Constants} from "../libs/Constants.sol";

/// @title Pool Storage
/// @notice Storage layout for portal pool implementation
/// @dev Separated from implementation to ensure clean upgrade paths
abstract contract PoolStorage {
    uint256 public constant PRECISION = Constants.PRECISION;
    uint256 public constant RATE_PRECISION = Constants.RATE_PRECISION;

    IPortalPool.PoolInfo internal _poolInfo;

    mapping(address => uint256) internal _stakes;

    mapping(address => uint256) internal _exitAmounts;
    uint256 internal _totalExitAmounts;

    IERC20 internal _sqd;
    IPortalRegistry internal _portalRegistry;
    IFeeRouter internal _feeRouter;
    IPortalFactory internal _factory;

    IERC20 internal _rewardToken;

    /// @notice pool's available credit (funds available for distribution)
    uint256 public credit;
    /// @notice pool's accumulated debt (owed but unpaid rewards)
    uint256 public debt;
    /// @notice timestamp of last balance checkpoint
    uint64 public balanceTs;
    /// @notice global reward per stake accumulator (scaled by ACC)
    uint256 public rewardPerStakeStored;
    /// @notice timestamp when rewards were last effectively accrued (stays at runway when dry)
    uint64 public lastEffectiveRewardTs;

    /// @notice total distribution rate per second (providers + treasury)
    /// @dev scaled by RATE_PRECISION (1000). A value of 1000 = 1 token/sec
    uint256 public totalDistributionRatePerSec;
    /// @notice provider portion of rate
    /// @dev scaled by RATE_PRECISION (1000). A value of 1000 = 1 token/sec
    uint256 public providerRatePerSec;
    /// @notice treasury portion of rate
    /// @dev scaled by RATE_PRECISION (1000). A value of 1000 = 1 token/sec
    uint256 public treasuryRatePerSec;
    /// @notice per-stake rate = providerRate * ACC / capacity
    uint256 public perStakeRateWad;
    /// @notice treasury accumulated rewards
    uint256 public treasuryAccumulated;

    /// @notice per-provider reward checkpoint (accumulated rewards at last update)
    mapping(address => uint256) internal _rewardCheckpoint;
    /// @notice per-provider unclaimed rewards
    mapping(address => uint256) internal _unclaimedRewards;

    ExitQueueLib.Queue internal _exitQueue;

    mapping(address => mapping(uint256 => ExitQueueLib.Ticket)) internal _exitTickets;
    mapping(address => uint256) internal _nextTicketId;

    LiquidPortalToken public lptToken;

    address public workerPoolAddress;
    address public burnAddress;

    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;

    /// @notice Scaling factor for reward token decimals (10^decimals)
    /// @dev For 18-decimal tokens = 1e18, for 6-decimal tokens = 1e6
    /// @dev Rate formula: rate = (target_tokens_per_month * 10^decimals * 1000) / 2592000
    /// @dev Example USDC rates: $1/mo=385, $100/mo=38580, $1000/mo=385802, $10000/mo=3858024
    uint256 internal _rewardTokenDecimalScale;

    uint256[50] private __gap;
}
