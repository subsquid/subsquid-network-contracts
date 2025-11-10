// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {PortalPool} from "./PortalPool.sol";
import {GatewayRegistry} from "./GatewayRegistry.sol";
import {FeeRouterModule} from "./FeeRouterModule.sol";
import {Errors} from "./libs/Errors.sol";

contract PortalFactory is Ownable, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable SQD;
    GatewayRegistry public immutable gatewayRegistry;
    FeeRouterModule public immutable feeRouter;

    mapping(address => bool) public supportedPaymentTokens;
    mapping(address => bool) public isPortal;
    address[] public portals;

    uint256 public constant DEFAULT_EPOCH_LENGTH = 7200;
    uint256 public constant DEFAULT_BASE_EXIT_DELAY = 1;
    uint256 public constant AVERAGE_BLOCK_TIME_SECONDS = 12;

    event PortalCreated(
        address indexed portal,
        address indexed consumer,
        uint256 targetSQD,
        uint256 minimumSQD,
        address paymentToken,
        uint256 budget
    );
    event PaymentTokenAdded(address indexed token);
    event PaymentTokenRemoved(address indexed token);

    constructor(
        address[] memory _supportedTokens,
        address _sqdToken,
        address _feeRouter,
        address _gatewayRegistry
    ) Ownable(msg.sender) {
        if (_sqdToken == address(0)) revert Errors.ZeroAddress();
        if (_feeRouter == address(0)) revert Errors.ZeroAddress();
        if (_gatewayRegistry == address(0)) revert Errors.ZeroAddress();

        SQD = IERC20(_sqdToken);
        feeRouter = FeeRouterModule(_feeRouter);
        gatewayRegistry = GatewayRegistry(_gatewayRegistry);

        for (uint256 i = 0; i < _supportedTokens.length; i++) {
            if (_supportedTokens[i] != address(0)) {
                supportedPaymentTokens[_supportedTokens[i]] = true;
                emit PaymentTokenAdded(_supportedTokens[i]);
            }
        }
    }

    function createPortal(
        address consumer,
        uint256 targetSQD,
        uint256 minimumSQD,
        uint64 depositDeadline,
        address paymentToken,
        uint256 budget
    ) external whenNotPaused returns (address portalAddr) {
        if (consumer == address(0)) revert Errors.ZeroAddress();
        if (!supportedPaymentTokens[paymentToken]) revert Errors.UnsupportedPaymentToken();
        if (depositDeadline <= block.timestamp) revert Errors.InvalidDeadline();
        if (budget == 0) revert Errors.ZeroAmount();

        if (minimumSQD < gatewayRegistry.MIN_STAKE_AMOUNT()) {
            revert Errors.BelowMinimumDeposit();
        }

        if (targetSQD < minimumSQD) revert Errors.InvalidParameters();

        PortalPool portal = new PortalPool(
            address(this),
            consumer,
            address(SQD),
            paymentToken,
            address(feeRouter),
            address(gatewayRegistry),
            targetSQD,
            minimumSQD,
            depositDeadline,
            DEFAULT_EPOCH_LENGTH,
            DEFAULT_BASE_EXIT_DELAY,
            AVERAGE_BLOCK_TIME_SECONDS
        );

        portalAddr = address(portal);

        gatewayRegistry.registerPortal(portalAddr);

        IERC20(paymentToken).safeTransferFrom(msg.sender, portalAddr, budget);

        portal.initialize();

        isPortal[portalAddr] = true;
        portals.push(portalAddr);

        emit PortalCreated(portalAddr, consumer, targetSQD, minimumSQD, paymentToken, budget);
    }

    function addPaymentToken(address token) external onlyOwner {
        if (token == address(0)) revert Errors.ZeroAddress();
        if (supportedPaymentTokens[token]) revert Errors.AlreadyInitialized();

        supportedPaymentTokens[token] = true;
        emit PaymentTokenAdded(token);
    }

    function removePaymentToken(address token) external onlyOwner {
        if (!supportedPaymentTokens[token]) revert Errors.InvalidAddress();

        supportedPaymentTokens[token] = false;
        emit PaymentTokenRemoved(token);
    }

    function pausePortal(address portal) external onlyOwner {
        if (!isPortal[portal]) revert Errors.InvalidAddress();
        PortalPool(portal).pause();
    }

    function unpausePortal(address portal) external onlyOwner {
        if (!isPortal[portal]) revert Errors.InvalidAddress();
        PortalPool(portal).unpause();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getPortalCount() external view returns (uint256) {
        return portals.length;
    }

    function getPortalAt(uint256 index) external view returns (address) {
        if (index >= portals.length) revert Errors.InvalidParameters();
        return portals[index];
    }

    function getAllPortals() external view returns (address[] memory) {
        return portals;
    }
}
