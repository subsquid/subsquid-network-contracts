// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "../test/mocks/MockNetworkController.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

contract DeployPortalSystem is Script {
    
    // default configuration values
    uint256 public constant DEFAULT_WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant DEFAULT_MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant DEFAULT_MANA = 1000;
    address public constant DEFAULT_WORKER_REWARD_POOL = address(0x1234567890123456789012345678901234567890);
    
    function run() external {
        // check if private key exists, otherwise use default account
        uint256 deployerPrivateKey;
        try vm.envUint("PRIVATE_KEY") returns (uint256 key) {
            deployerPrivateKey = key;
            vm.startBroadcast(deployerPrivateKey);
        } catch {
            console.log("No PRIVATE_KEY found, using default account for local testing");
            vm.startBroadcast();
        }
        
        // deploy mock SQD token
        MockERC20 sqd = new MockERC20("Subsquid", "SQD", 18);
        console.log("SQD Token deployed:", address(sqd));
        
        // deploy mock payment tokens (optional, for multi-token testing)
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 dai = new MockERC20("Dai Stablecoin", "DAI", 18);
        console.log("USDC Token deployed:", address(usdc));
        console.log("DAI Token deployed:", address(dai));
        
        // get configuration from environment or use defaults
        uint256 workerEpochLength = _getEnvUint("WORKER_EPOCH_LENGTH", DEFAULT_WORKER_EPOCH_LENGTH);
        uint256 minStakeThreshold = _getEnvUint("MIN_STAKE_THRESHOLD", DEFAULT_MIN_STAKE_THRESHOLD);
        address workerRewardPool = _getEnvAddress("WORKER_REWARD_POOL", DEFAULT_WORKER_REWARD_POOL);
        uint256 mana = _getEnvUint("MANA", DEFAULT_MANA);
        
        // deploy network controller
        MockNetworkController networkController = new MockNetworkController(
            workerEpochLength,
            minStakeThreshold,
            workerRewardPool
        );
        console.log("NetworkController deployed:", address(networkController));
        
        // deploy gateway registry
        GatewayRegistry gatewayRegistry = new GatewayRegistry(
            address(sqd),
            address(networkController),
            minStakeThreshold,
            mana
        );
        console.log("GatewayRegistry deployed:", address(gatewayRegistry));
        
        // deploy fee router
        FeeRouterModule feeRouter = new FeeRouterModule();
        console.log("FeeRouterModule deployed:", address(feeRouter));
        
        // deploy portal implementation
        PortalImplementation implementation = new PortalImplementation();
        console.log("PortalImplementation deployed:", address(implementation));
        
        // deploy factory
        PortalFactory factory = new PortalFactory(
            address(implementation),
            address(gatewayRegistry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            minStakeThreshold
        );
        console.log("PortalFactory deployed:", address(factory));
        
        // set factory in gateway registry (required for portal creation)
        gatewayRegistry.setFactory(address(factory));
        console.log("Factory set in GatewayRegistry");
        
        // print deployment summary
        console.log("\n=== Deployment Summary ===");
        console.log("SQD Token:", address(sqd));
        console.log("USDC Token:", address(usdc));
        console.log("DAI Token:", address(dai));
        console.log("NetworkController:", address(networkController));
        console.log("GatewayRegistry:", address(gatewayRegistry));
        console.log("FeeRouterModule:", address(feeRouter));
        console.log("PortalImplementation:", address(implementation));
        console.log("PortalFactory:", address(factory));
        console.log("\n=== Configuration ===");
        console.log("Worker Epoch Length:", workerEpochLength);
        console.log("Min Stake Threshold:", minStakeThreshold);
        console.log("Mana:", mana);
        console.log("Worker Reward Pool:", workerRewardPool);
        
        vm.stopBroadcast();
    }
    
    function _getEnvUint(string memory name, uint256 defaultValue) internal view returns (uint256) {
        try vm.envUint(name) returns (uint256 value) {
            return value;
        } catch {
            return defaultValue;
        }
    }
    
    function _getEnvAddress(string memory name, address defaultValue) internal view returns (address) {
        try vm.envAddress(name) returns (address value) {
            return value;
        } catch {
            return defaultValue;
        }
    }
}
