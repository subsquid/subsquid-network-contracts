// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPortal} from "./interfaces/IPortal.sol";

contract PortalFactory is AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address public implementation;
    address public gatewayRegistry;
    address public feeRouter;
    address public networkController;
    address public sqd;

    address[] public allPortals;
    mapping(address => address[]) public operatorPortals;
    mapping(address => bool) public isPortal;

    uint256 public minStakeThreshold;

    event PortalCreated(address indexed portal, address indexed operator, bytes peerId);

    event PortalPaymentTokensSet(address indexed portal, address[] paymentTokens);

    event PortalUpgraded(address indexed portal, address indexed newImplementation);

    error InvalidAddress();
    error InvalidPortal();
    error InvalidRange();
    error NoPaymentTokens();
    error BelowMinimum();
    error InvalidDeadline();
    error EmptyPeerId();

    constructor(
        address _implementation,
        address _gatewayRegistry,
        address _feeRouter,
        address _networkController,
        address _sqd,
        uint256 _minStakeThreshold
    ) {
        if (_implementation == address(0)) revert InvalidAddress();
        if (_gatewayRegistry == address(0)) revert InvalidAddress();
        if (_feeRouter == address(0)) revert InvalidAddress();
        if (_networkController == address(0)) revert InvalidAddress();
        if (_sqd == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        implementation = _implementation;
        gatewayRegistry = _gatewayRegistry;
        feeRouter = _feeRouter;
        networkController = _networkController;
        sqd = _sqd;
        minStakeThreshold = _minStakeThreshold;
    }

    function createPortal(
        address operator,
        address[] calldata paymentTokens,
        uint256 maxCapacity,
        uint256 depositDeadline,
        bytes calldata peerId
    ) external whenNotPaused returns (address portal) {
        if (operator == address(0)) revert InvalidAddress();
        if (paymentTokens.length == 0) revert NoPaymentTokens();
        if (maxCapacity < minStakeThreshold) revert BelowMinimum();
        if (depositDeadline <= block.number) revert InvalidDeadline();
        if (peerId.length == 0) revert EmptyPeerId();

        for (uint256 i = 0; i < paymentTokens.length; ++i) {
            if (paymentTokens[i] == address(0)) revert InvalidAddress();
        }

        portal = Clones.clone(implementation);

        IPortal(portal).initialize(
            operator, maxCapacity, depositDeadline, peerId, sqd, gatewayRegistry, feeRouter, networkController
        );

        IPortal(portal).initializePaymentTokens(paymentTokens);

        allPortals.push(portal);
        operatorPortals[operator].push(portal);
        isPortal[portal] = true;

        emit PortalCreated(portal, operator, peerId);
        emit PortalPaymentTokensSet(portal, paymentTokens);
    }

    function upgradePortal(address portal, address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isPortal[portal]) revert InvalidPortal();
        if (newImplementation == address(0)) revert InvalidAddress();

        IPortal(portal).upgradeTo(newImplementation);

        emit PortalUpgraded(portal, newImplementation);
    }

    function upgradeAllPortals(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();

        _upgradePortalsBatch(newImplementation, 0, allPortals.length);
    }

    function upgradePortalsBatch(address newImplementation, uint256 startIndex, uint256 endIndex)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _upgradePortalsBatch(newImplementation, startIndex, endIndex);
    }

    function _upgradePortalsBatch(address newImplementation, uint256 startIndex, uint256 endIndex) internal {
        if (newImplementation == address(0)) revert InvalidAddress();
        if (endIndex > allPortals.length) revert InvalidRange();
        if (startIndex >= endIndex) revert InvalidRange();

        for (uint256 i = startIndex; i < endIndex; ++i) {
            IPortal(allPortals[i]).upgradeTo(newImplementation);
            emit PortalUpgraded(allPortals[i], newImplementation);
        }
    }

    function getPortalCount() external view returns (uint256) {
        return allPortals.length;
    }

    function getOperatorPortals(address operator) external view returns (address[] memory) {
        return operatorPortals[operator];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setImplementation(address _implementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_implementation == address(0)) revert InvalidAddress();
        implementation = _implementation;
    }

    function setMinStakeThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minStakeThreshold = _threshold;
    }
}
