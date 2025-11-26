// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPortal} from "./interfaces/IPortal.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IGatewayRegistry} from "./interfaces/IGatewayRegistry.sol";
import {GatewayErrors} from "./libs/GatewayErrors.sol";

contract GatewayRegistry is IGatewayRegistry, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable SQD;
    INetworkController public networkController;

    mapping(address => Portal) public portals;
    mapping(bytes32 => address) public peerIdToPortal;

    mapping(address => mapping(address => uint256)) public providerAllocations;

    mapping(address => address[]) private _providerPortals;

    mapping(address => UnlockRequest) public unlockRequests;

    uint256 public constant MAX_UNLOCK_PER_EPOCH_BPS = 100;
    uint256 public minStake;
    uint256 public mana;

    constructor(address _sqd, address _networkController, uint256 _minStake, uint256 _mana) {
        if (_sqd == address(0)) revert GatewayErrors.InvalidAddress();
        if (_networkController == address(0)) revert GatewayErrors.InvalidAddress();

        SQD = IERC20(_sqd);
        networkController = INetworkController(_networkController);
        minStake = _minStake;
        mana = _mana;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    function registerPortal(bytes calldata peerId, address portalAddress, address operator) external {
        if (msg.sender != portalAddress) revert GatewayErrors.OnlyPortal();
        if (portals[portalAddress].portalAddress != address(0)) revert GatewayErrors.PortalAlreadyRegistered();

        bytes32 peerIdHash = keccak256(peerId);
        if (peerIdToPortal[peerIdHash] != address(0)) revert GatewayErrors.PeerIdInUse();

        portals[portalAddress] = Portal({
            peerId: peerId,
            portalAddress: portalAddress,
            totalStaked: 0,
            registeredAt: block.number,
            active: false
        });

        peerIdToPortal[peerIdHash] = portalAddress;

        emit PortalRegistered(portalAddress, peerId, operator);
    }

    function stake(address portalAddress, address provider, uint256 amount) external whenNotPaused {
        if (msg.sender != portalAddress) revert GatewayErrors.OnlyPortal();
        if (portals[portalAddress].portalAddress == address(0)) revert GatewayErrors.PortalNotRegistered();

        SQD.safeTransferFrom(provider, address(this), amount);

        if (providerAllocations[portalAddress][provider] == 0) {
            _providerPortals[provider].push(portalAddress);
        }

        providerAllocations[portalAddress][provider] += amount;

        Portal storage portal = portals[portalAddress];
        portal.totalStaked += amount;

        if (!portal.active && portal.totalStaked >= minStake) {
            portal.active = true;
            emit PortalActivated(portalAddress);
        }

        emit Staked(portalAddress, provider, amount);
    }

    function requestUnlock(address provider, uint256 amount) external whenNotPaused {
        if (portals[msg.sender].portalAddress == address(0)) revert GatewayErrors.OnlyPortal();

        uint256 totalAllocation = getTotalAllocation(provider);
        if (totalAllocation < amount) revert GatewayErrors.InsufficientAllocation();

        UnlockRequest storage request = unlockRequests[provider];
        request.amount = amount;
        request.requestedAt = networkController.epochNumber();
        request.withdrawn = 0;

        emit UnlockRequested(provider, amount, request.requestedAt);
    }

    function withdrawUnlocked() external whenNotPaused {
        UnlockRequest storage request = unlockRequests[msg.sender];
        if (request.amount == 0) revert GatewayErrors.NoUnlockRequest();

        uint256 currentEpoch = networkController.epochNumber();
        uint256 epochsPassed = currentEpoch - request.requestedAt;

        uint256 totalAllocation = getTotalAllocation(msg.sender);
        uint256 maxPerEpoch = (totalAllocation * MAX_UNLOCK_PER_EPOCH_BPS) / 10000;

        uint256 totalUnlocked = epochsPassed * maxPerEpoch;
        if (totalUnlocked > request.amount) {
            totalUnlocked = request.amount;
        }

        uint256 withdrawable = totalUnlocked - request.withdrawn;
        if (withdrawable == 0) revert GatewayErrors.NothingToWithdraw();

        request.withdrawn += withdrawable;

        if (request.withdrawn >= request.amount) {
            delete unlockRequests[msg.sender];
        }

        _reduceAllocations(msg.sender, withdrawable);

        SQD.safeTransfer(msg.sender, withdrawable);

        emit Withdrawn(msg.sender, withdrawable);
    }

    function withdrawFailedPortal(address provider, uint256 amount) external whenNotPaused {
        address portalAddress = msg.sender;
        if (portals[portalAddress].portalAddress == address(0)) revert GatewayErrors.PortalNotRegistered();
        if (providerAllocations[portalAddress][provider] < amount) revert GatewayErrors.InsufficientAllocation();

        providerAllocations[portalAddress][provider] -= amount;
        portals[portalAddress].totalStaked -= amount;

        if (providerAllocations[portalAddress][provider] == 0) {
            _removeProviderPortal(provider, portalAddress);
        }

        if (unlockRequests[provider].amount > 0) {
            delete unlockRequests[provider];
        }

        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    function _reduceAllocations(address provider, uint256 amount) internal {
        address[] memory providerPortalList = getProviderPortals(provider);
        uint256 totalAllocation = getTotalAllocation(provider);

        uint256 remaining = amount;
        for (uint256 i = 0; i < providerPortalList.length && remaining > 0; ++i) {
            address portal = providerPortalList[i];
            uint256 allocation = providerAllocations[portal][provider];

            uint256 reduction = (amount * allocation) / totalAllocation;
            if (reduction > remaining) reduction = remaining;
            if (reduction > allocation) reduction = allocation;

            providerAllocations[portal][provider] -= reduction;
            portals[portal].totalStaked -= reduction;

            remaining -= reduction;

            IPortal(portal).onAllocationReduced(provider, reduction);

            if (providerAllocations[portal][provider] == 0) {
                _removeProviderPortal(provider, portal);
            }
        }
    }

    function getComputationUnits(address portalAddress) external view returns (uint256) {
        Portal storage portal = portals[portalAddress];

        if (!portal.active) return 0;

        uint256 epochLength = networkController.workerEpochLength();
        uint256 boostFactor = 30000;

        uint256 cus = (portal.totalStaked * epochLength * mana * boostFactor) / (10000 * 1e18 * 1000);

        return cus;
    }

    function getTotalAllocation(address provider) public view returns (uint256 total) {
        address[] memory providerPortalList = getProviderPortals(provider);
        for (uint256 i = 0; i < providerPortalList.length; ++i) {
            total += providerAllocations[providerPortalList[i]][provider];
        }
    }

    function getProviderPortals(address provider) public view returns (address[] memory) {
        return _providerPortals[provider];
    }

    function _removeProviderPortal(address provider, address portal) internal {
        address[] storage providerPortalList = _providerPortals[provider];
        for (uint256 i = 0; i < providerPortalList.length; ++i) {
            if (providerPortalList[i] == portal) {
                providerPortalList[i] = providerPortalList[providerPortalList.length - 1];
                providerPortalList.pop();
                break;
            }
        }
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setMinStake(uint256 _minStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = minStake;
        minStake = _minStake;
        emit MinStakeUpdated(oldValue, _minStake);
    }

    function setMana(uint256 _mana) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = mana;
        mana = _mana;
        emit ManaUpdated(oldValue, _mana);
    }
}
