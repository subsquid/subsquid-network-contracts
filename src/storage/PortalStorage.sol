// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGatewayRegistry} from "../interfaces/IGatewayRegistry.sol";
import {IFeeRouter} from "../interfaces/IFeeRouter.sol";
import {INetworkController} from "../interfaces/INetworkController.sol";

abstract contract PortalStorage {

    enum PortalState {
        COLLECTING,
        ACTIVE,
        FAILED
    }

    struct PortalInfo {
        address operator;
        uint256 maxCapacity;
        uint256 totalStaked;
        uint64 depositDeadline;
        uint64 activationTime;
        PortalState state;
        bool paused;
    }

    struct ExitRequest {
        uint256 amount;
        uint64 requestEpoch;
        uint64 unlockEpoch;
    }

    PortalInfo internal _portalInfo;
    bytes internal _peerId;

    mapping(address => uint256) internal _stakes;
    mapping(address => ExitRequest) internal _exitRequests;

    // Track amounts that are in exit queue (stop earning rewards)
    mapping(address => uint256) internal _exitAmounts;

    // Track total exit amounts for active stake calculation
    uint256 internal _totalExitAmounts;

    // Multi-token fee tracking
    mapping(address => bool) public allowedPaymentTokens;
    address[] public paymentTokensList;
    mapping(address => uint256) internal _cumulativeFeesPerShare;
    mapping(address => mapping(address => uint256)) internal _providerCheckpoint;
    mapping(address => uint256) public totalFeesDistributed;
    mapping(address => uint256) public lastDistributionTime;
    mapping(address => mapping(address => uint256)) internal _providerTotalClaimed;

    IERC20 internal _sqd;
    IGatewayRegistry internal _gatewayRegistry;
    IFeeRouter internal _feeRouter;
    INetworkController internal _networkController;

    uint256[47] private __gap;
}
