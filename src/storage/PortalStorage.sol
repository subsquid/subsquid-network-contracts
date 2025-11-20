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
    
    PortalInfo internal _portalInfo;
    bytes internal _peerId;
    
    mapping(address => uint256) internal _stakes;
    mapping(address => ExitRequest) internal _exitRequests;
    mapping(address => uint256) internal _earnedFees;

    // Track amounts that are in exit queue (stop earning rewards)
    mapping(address => uint256) internal _exitAmounts;

    // Multi-token fee tracking
    mapping(address => bool) public allowedPaymentTokens; // Token => is allowed
    address[] public paymentTokensList; // Array to track allowed tokens for enumeration
    mapping(address => uint256) internal _cumulativeFeesPerShare; // Token => cumulative fees per share
    mapping(address => mapping(address => uint256)) internal _providerCheckpoint; // Token => Provider => checkpoint
    mapping(address => uint256) public totalFeesDistributed; // Token => total distributed
    mapping(address => uint256) public lastDistributionTime; // Token => last distribution time
    mapping(address => mapping(address => uint256)) internal _providerTotalClaimed; // Token => Provider => total claimed

    IERC20 internal _sqd;
    IGatewayRegistry internal _gatewayRegistry;
    IFeeRouter internal _feeRouter;
    INetworkController internal _networkController;

    uint256[49] private __gap;
}
