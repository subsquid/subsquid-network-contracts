// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPortal} from "./interfaces/IPortal.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";

contract GatewayRegistry is AccessControl, Pausable {
    using SafeERC20 for IERC20;
    
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    
    struct Portal {
        bytes peerId;
        address portalAddress;
        uint256 totalStaked;
        uint256 registeredAt;
        bool active;
        string metadata;
    }
    
    struct UnlockRequest {
        uint256 amount;
        uint256 requestedAt;
        uint256 withdrawn;
    }
    
    IERC20 public immutable SQD;
    INetworkController public networkController;
    address public factory;
    
    mapping(address => Portal) public portals;
    mapping(bytes32 => address) public peerIdToPortal;
    
    mapping(address => mapping(address => uint256)) public providerAllocations;

    mapping(address => address[]) private _providerPortals;

    mapping(address => UnlockRequest) public unlockRequests;
    
    uint256 public constant MAX_UNLOCK_PER_EPOCH_BPS = 100;
    uint256 public minStake;
    uint256 public mana;
    
    event PortalRegistered(address indexed portal, bytes peerId, address operator);
    event PortalActivated(address indexed portal);
    event Staked(address indexed portal, address indexed provider, uint256 amount);
    event StakeReallocated(
        address indexed fromPortal,
        address indexed toPortal,
        address indexed provider,
        uint256 amount
    );
    event UnlockRequested(address indexed provider, uint256 amount, uint256 requestedAt);
    event Withdrawn(address indexed provider, uint256 amount);
    event MinStakeUpdated(uint256 oldValue, uint256 newValue);
    event ManaUpdated(uint256 oldValue, uint256 newValue);
    
    constructor(
        address _sqd,
        address _networkController,
        uint256 _minStake,
        uint256 _mana
    ) {
        require(_sqd != address(0), "Invalid SQD");
        require(_networkController != address(0), "Invalid controller");

        SQD = IERC20(_sqd);
        networkController = INetworkController(_networkController);
        minStake = _minStake;
        mana = _mana;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    function setFactory(address _factory) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_factory != address(0), "Invalid factory");
        factory = _factory;
    }
    
    function registerPortal(
        bytes calldata peerId,
        address portalAddress,
        address operator
    ) external {
        require(msg.sender == portalAddress, "Only portal");
        require(portals[portalAddress].portalAddress == address(0), "Already registered");
        
        bytes32 peerIdHash = keccak256(peerId);
        require(peerIdToPortal[peerIdHash] == address(0), "PeerId in use");
        
        portals[portalAddress] = Portal({
            peerId: peerId,
            portalAddress: portalAddress,
            totalStaked: 0,
            registeredAt: block.number,
            active: false,
            metadata: ""
        });
        
        peerIdToPortal[peerIdHash] = portalAddress;
        
        emit PortalRegistered(portalAddress, peerId, operator);
    }
    
    function stake(
        address portalAddress,
        address provider,
        uint256 amount
    ) external whenNotPaused {
        require(msg.sender == portalAddress, "Only portal");
        require(portals[portalAddress].portalAddress != address(0), "Portal not registered");
        
        SQD.safeTransferFrom(provider, address(this), amount);

        // Track portal for provider if first allocation
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
    // in progress, -> do zobaczennia bo testsy sie wysadzaja 
    function reallocate(
        address fromPortal,
        address toPortal,
        address provider,
        uint256 amount
    ) external whenNotPaused {
        require(fromPortal != address(0), "Invalid source");
        require(toPortal != address(0), "Invalid destination");
        require(provider != address(0), "Invalid provider");
        require(fromPortal != toPortal, "Same portal");
        require(amount > 0, "Invalid amount");

        require(
            msg.sender == fromPortal || msg.sender == factory,
            "Only portal or factory"
        );

        require(portals[fromPortal].portalAddress != address(0), "Source not registered");
        require(portals[toPortal].portalAddress != address(0), "Destination not registered");

        require(
            providerAllocations[fromPortal][provider] >= amount,
            "Insufficient allocation"
        );
        
        providerAllocations[fromPortal][provider] -= amount;

        if (providerAllocations[fromPortal][provider] == 0) {
            _removeProviderPortal(provider, fromPortal);
        }
        if (providerAllocations[toPortal][provider] == 0) {
            _providerPortals[provider].push(toPortal);
        }

        providerAllocations[toPortal][provider] += amount;
        
        portals[fromPortal].totalStaked -= amount;
        portals[toPortal].totalStaked += amount;
        
        if (portals[fromPortal].totalStaked < minStake) {
            portals[fromPortal].active = false;
        }
        if (!portals[toPortal].active && portals[toPortal].totalStaked >= minStake) {
            portals[toPortal].active = true;
        }
        
        emit StakeReallocated(fromPortal, toPortal, provider, amount);
    }
    
    function requestUnlock(address provider, uint256 amount) external whenNotPaused {
        uint256 totalAllocation = getTotalAllocation(provider);
        
        require(totalAllocation >= amount, "Insufficient total");
        
        UnlockRequest storage request = unlockRequests[provider];
        request.amount = amount;
        request.requestedAt = networkController.epochNumber();
        request.withdrawn = 0;
        
        emit UnlockRequested(provider, amount, request.requestedAt);
    }
    
    function withdrawUnlocked() external whenNotPaused {
        UnlockRequest storage request = unlockRequests[msg.sender];
        require(request.amount > 0, "No unlock request");

        uint256 currentEpoch = networkController.epochNumber();
        uint256 epochsPassed = currentEpoch - request.requestedAt;

        uint256 totalAllocation = getTotalAllocation(msg.sender);
        uint256 maxPerEpoch = (totalAllocation * MAX_UNLOCK_PER_EPOCH_BPS) / 10000;

        uint256 totalUnlocked = epochsPassed * maxPerEpoch;
        if (totalUnlocked > request.amount) {
            totalUnlocked = request.amount;
        }

        uint256 withdrawable = totalUnlocked - request.withdrawn;
        require(withdrawable > 0, "Nothing to withdraw");

        request.withdrawn += withdrawable;

        if (request.withdrawn >= request.amount) {
            delete unlockRequests[msg.sender];
        }

        _reduceAllocations(msg.sender, withdrawable);

        SQD.safeTransfer(msg.sender, withdrawable);

        emit Withdrawn(msg.sender, withdrawable);
    }

    function withdrawFailedPortal(address provider, uint256 amount) external whenNotPaused {
        // Only portals can call this function for their providers
        address portalAddress = msg.sender;
        require(portals[portalAddress].portalAddress != address(0), "Portal not registered");
        require(providerAllocations[portalAddress][provider] >= amount, "Insufficient allocation");

        // Immediate withdrawal for FAILED portals (no unlock delay)
        providerAllocations[portalAddress][provider] -= amount;
        portals[portalAddress].totalStaked -= amount;

        // Remove portal from provider's list if allocation becomes zero
        if (providerAllocations[portalAddress][provider] == 0) {
            _removeProviderPortal(provider, portalAddress);
        }

        // Clear any existing unlock request for this provider
        if (unlockRequests[provider].amount > 0) {
            delete unlockRequests[provider];
        }

        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    function _reduceAllocations(address provider, uint256 amount) internal {
        address[] memory providerPortals = getProviderPortals(provider);
        uint256 totalAllocation = getTotalAllocation(provider);
        
        uint256 remaining = amount;
        for (uint256 i = 0; i < providerPortals.length && remaining > 0; ++i) {
            address portal = providerPortals[i];
            uint256 allocation = providerAllocations[portal][provider];
            
            uint256 reduction = (amount * allocation) / totalAllocation;
            if (reduction > remaining) reduction = remaining;
            if (reduction > allocation) reduction = allocation;
            
            providerAllocations[portal][provider] -= reduction;
            portals[portal].totalStaked -= reduction;
            
            remaining -= reduction;
            
            IPortal(portal).onAllocationReduced(provider, reduction);
        }
    }
    
    function getComputationUnits(address portalAddress) 
        external 
        view 
        returns (uint256) 
    {
        Portal storage portal = portals[portalAddress];
        
        if (!portal.active) return 0;
        
        uint256 epochLength = networkController.workerEpochLength();
        uint256 boostFactor = 30000;
        
        uint256 cus = (
            portal.totalStaked 
            * epochLength 
            * mana 
            * boostFactor
        ) / (10000 * 1e18 * 1000);
        
        return cus;
    }
    
    function getTotalAllocation(address provider) public view returns (uint256 total) {
        address[] memory providerPortals = getProviderPortals(provider);
        for (uint256 i = 0; i < providerPortals.length; ++i) {
            total += providerAllocations[providerPortals[i]][provider];
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
