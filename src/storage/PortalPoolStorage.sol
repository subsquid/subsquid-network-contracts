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

    uint256 public maxStakePerWallet;

    IERC20 internal _usdc;
    uint256 public distributionRateScaled;
    uint256 public lastRewardBalanceScaled;
    uint256 public lastRewardTimestamp;
    mapping(address => IPortalPool.DelegatorCheckpoint) internal _delegatorCheckpoints;

    ExitQueueLib.Queue internal _exitQueue;

    mapping(address => mapping(uint256 => ExitQueueLib.Ticket)) internal _exitTickets;
    mapping(address => uint256) internal _nextTicketId;

    LiquidPortalToken public lptToken;

    mapping(address => mapping(address => uint256)) internal _feeDebt;
    mapping(address => mapping(address => uint256)) internal _unclaimedFees;

    uint256[50] private __gap;
}
