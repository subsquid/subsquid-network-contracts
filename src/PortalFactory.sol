// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPortal} from "./interfaces/IPortal.sol";
import {IGatewayRegistry} from "./interfaces/IGatewayRegistry.sol";

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
    
    event PortalCreated(
        address indexed portal,
        address indexed operator,
        bytes peerId
    );

    event PortalPaymentTokensSet(
        address indexed portal,
        address[] paymentTokens
    );
    
    event PortalUpgraded(
        address indexed portal,
        address indexed newImplementation
    );
    
    event StakeMoved(
        address indexed fromPortal,
        address indexed toPortal,
        address indexed provider,
        uint256 amount
    );
    
    constructor(
        address _implementation,
        address _gatewayRegistry,
        address _feeRouter,
        address _networkController,
        address _sqd,
        uint256 _minStakeThreshold
    ) {
        require(_implementation != address(0), "Invalid implementation");
        require(_gatewayRegistry != address(0), "Invalid gateway");
        require(_feeRouter != address(0), "Invalid fee router");
        require(_networkController != address(0), "Invalid controller");
        require(_sqd != address(0), "Invalid SQD");
        
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
        bytes calldata peerId,
        string calldata metadata
    ) external whenNotPaused returns (address portal) {
        require(operator != address(0), "Invalid operator");
        require(paymentTokens.length > 0, "No payment tokens provided");
        require(maxCapacity >= minStakeThreshold, "Below minimum");
        require(depositDeadline > block.number, "Invalid deadline");
        require(peerId.length > 0, "Empty peer ID");

        // Validate all tokens are non-zero
        for (uint256 i = 0; i < paymentTokens.length; ++i) {
            require(paymentTokens[i] != address(0), "Invalid payment token");
        }

        portal = Clones.clone(implementation);

        IPortal(portal).initialize(
            operator,
            maxCapacity,
            depositDeadline,
            peerId,
            sqd,
            gatewayRegistry,
            feeRouter,
            networkController
        );

        // Set all payment tokens
        IPortal(portal).initializePaymentTokens(paymentTokens);

        allPortals.push(portal);
        operatorPortals[operator].push(portal);
        isPortal[portal] = true;

        emit PortalCreated(portal, operator, peerId);
        emit PortalPaymentTokensSet(portal, paymentTokens);
    }
    
    function moveStake(
        address fromPortal,
        address toPortal,
        uint256 amount
    ) external whenNotPaused {
        // H-5: Zero address checks
        require(fromPortal != address(0), "Invalid source");
        require(toPortal != address(0), "Invalid destination");
        require(fromPortal != toPortal, "Same portal");
        require(amount > 0, "Invalid amount");
        require(isPortal[fromPortal], "Invalid source portal");
        require(isPortal[toPortal], "Invalid destination portal");
        
        IPortal(fromPortal).withdrawForMove(msg.sender, amount);
        
        IPortal(toPortal).depositFromMove(msg.sender, amount);
        
        IGatewayRegistry(gatewayRegistry).reallocate(
            fromPortal,
            toPortal,
            msg.sender,
            amount
        );
        
        emit StakeMoved(fromPortal, toPortal, msg.sender, amount);
    }
    
    function upgradePortal(
        address portal,
        address newImplementation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(isPortal[portal], "Not a portal");
        require(newImplementation != address(0), "Invalid implementation");
        
        IPortal(portal).upgradeTo(newImplementation);
        
        emit PortalUpgraded(portal, newImplementation);
    }
    
    function upgradeAllPortals(
        address newImplementation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newImplementation != address(0), "Invalid implementation");

        _upgradePortalsBatch(newImplementation, 0, allPortals.length);
    }

    function upgradePortalsBatch(
        address newImplementation,
        uint256 startIndex,
        uint256 endIndex
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _upgradePortalsBatch(newImplementation, startIndex, endIndex);
    }

    function _upgradePortalsBatch(
        address newImplementation,
        uint256 startIndex,
        uint256 endIndex
    ) internal {
        require(newImplementation != address(0), "Invalid implementation");
        require(endIndex <= allPortals.length, "Invalid range");
        require(startIndex < endIndex, "Invalid range");

        for (uint256 i = startIndex; i < endIndex; ++i) {
            IPortal(allPortals[i]).upgradeTo(newImplementation);
            emit PortalUpgraded(allPortals[i], newImplementation);
        }
    }
    
    function getPortalCount() external view returns (uint256) {
        return allPortals.length;
    }
    
    function getOperatorPortals(address operator) 
        external 
        view 
        returns (address[] memory) 
    {
        return operatorPortals[operator];
    }
    
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
    
    function setImplementation(address _implementation) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        require(_implementation != address(0), "Invalid implementation");
        implementation = _implementation;
    }
    
    function setMinStakeThreshold(uint256 _threshold) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        minStakeThreshold = _threshold;
    }
}
