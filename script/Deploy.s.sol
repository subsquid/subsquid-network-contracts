// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "../test/mocks/MockNetworkController.sol";

contract DeployPortalSystem is Script {
    // Arbitrum Sepolia token addresses
    address public constant SQD = 0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c;
    address public constant USDC = 0x8baf8707861a84e3d978aC067447de9AAd862FAc;

    // Configuration values
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;

    struct DeployedContracts {
        address networkController;
        address portalRegistry;
        address feeRouter;
        address implementation;
        address factory;
        address beacon;
    }

    function run() external returns (DeployedContracts memory deployed) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("SQD Token:", SQD);
        console.log("USDC Token:", USDC);

        vm.startBroadcast(deployerPrivateKey);

        deployed = _deployAll(deployer);

        vm.stopBroadcast();

        _printSummary(deployed);

        return deployed;
    }

    function runLocal() external returns (DeployedContracts memory deployed) {
        address deployer = address(this);

        console.log("Local deployment (no broadcast)");
        console.log("SQD Token:", SQD);
        console.log("USDC Token:", USDC);

        vm.startBroadcast();

        deployed = _deployAll(deployer);

        vm.stopBroadcast();

        _printSummary(deployed);

        return deployed;
    }

    function _deployAll(address deployer) internal returns (DeployedContracts memory d) {
        address workerRewardPool = 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee;

        console.log("\n--- Deploying NetworkController ---");
        MockNetworkController networkController =
            new MockNetworkController(WORKER_EPOCH_LENGTH, MIN_STAKE_THRESHOLD, workerRewardPool);
        d.networkController = address(networkController);
        console.log("NetworkController deployed at:", d.networkController);

        console.log("\n--- Deploying PortalRegistry ---");
        PortalRegistry portalRegistry = new PortalRegistry(SQD, d.networkController, MIN_STAKE_THRESHOLD, MANA);
        d.portalRegistry = address(portalRegistry);
        console.log("PortalRegistry deployed at:", d.portalRegistry);

        console.log("\n--- Deploying FeeRouterModule ---");
        FeeRouterModule feeRouter = new FeeRouterModule();
        d.feeRouter = address(feeRouter);
        console.log("FeeRouterModule deployed at:", d.feeRouter);

        console.log("\n--- Deploying PortalPoolImplementation ---");
        PortalPoolImplementation implementation = new PortalPoolImplementation();
        d.implementation = address(implementation);
        console.log("PortalPoolImplementation deployed at:", d.implementation);

        console.log("\n--- Deploying PortalPoolFactory ---");
        PortalPoolFactory factory = new PortalPoolFactory(
            d.implementation, d.portalRegistry, d.feeRouter, d.networkController, SQD, USDC, MAX_STAKE_PER_WALLET
        );
        d.factory = address(factory);
        d.beacon = address(factory.beacon());
        console.log("PortalPoolFactory deployed at:", d.factory);
        console.log("PortalPoolBeacon deployed at:", d.beacon);

        console.log("\n--- Setting Factory in Registry ---");
        portalRegistry.setFactory(d.factory);
        console.log("Factory set in PortalRegistry");

        console.log("\n--- Setting Worker Pool Address ---");
        // note: workerPoolAddress should be set after deployment:
        factory.setWorkerPoolAddress(workerRewardPool);
        console.log("Worker pool address set to:", workerRewardPool);

        console.log("\n--- Adding Payment Tokens ---");
        factory.addPaymentToken(USDC);
        console.log("USDC added as payment token");

        console.log("\n--- Verifying Configuration ---");
        require(factory.sqd() == SQD, "SQD address mismatch");
        require(factory.usdc() == USDC, "USDC address mismatch");
        require(factory.isAllowedPaymentToken(USDC), "USDC not added as payment token");
        require(portalRegistry.factory() == d.factory, "Factory not set in registry");
        require(factory.workerPoolAddress() == workerRewardPool, "Worker pool address not set");
        console.log("Configuration verified successfully");
    }

    function _printSummary(DeployedContracts memory d) internal pure {
        console.log("\n========================================");
        console.log("       DEPLOYMENT SUMMARY");
        console.log("========================================");
        console.log("");
        console.log("Tokens:");
        console.log("  SQD:", SQD);
        console.log("  USDC:", USDC);
        console.log("");
        console.log("Core Contracts:");
        console.log("  NetworkController:", d.networkController);
        console.log("  PortalRegistry:", d.portalRegistry);
        console.log("  FeeRouterModule:", d.feeRouter);
        console.log("");
        console.log("Factory System:");
        console.log("  PortalPoolImplementation:", d.implementation);
        console.log("  PortalPoolFactory:", d.factory);
        console.log("  PortalPoolBeacon:", d.beacon);
        console.log("");
        console.log("Configuration:");
        console.log("  Min Stake Threshold:", MIN_STAKE_THRESHOLD / 1e18, "SQD");
        console.log("  Max Pool Capacity:", MAX_POOL_CAPACITY / 1e18, "SQD");
        console.log("  Max Stake Per Wallet:", MAX_STAKE_PER_WALLET / 1e18, "SQD");
        console.log("  Mana:", MANA);
        console.log("  Worker Pool Address: 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee");
        console.log("========================================");
    }
}

contract DeployWithExistingController is Script {
    address public constant SQD = 0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;

    function run(address networkController) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        console.log("Using existing NetworkController:", networkController);

        vm.startBroadcast(deployerPrivateKey);

        console.log("\n--- Deploying PortalRegistry ---");
        PortalRegistry portalRegistry = new PortalRegistry(SQD, networkController, MIN_STAKE_THRESHOLD, MANA);
        console.log("PortalRegistry deployed at:", address(portalRegistry));

        console.log("\n--- Deploying FeeRouterModule ---");
        FeeRouterModule feeRouter = new FeeRouterModule();
        console.log("FeeRouterModule deployed at:", address(feeRouter));

        console.log("\n--- Deploying PortalPoolImplementation ---");
        PortalPoolImplementation implementation = new PortalPoolImplementation();
        console.log("PortalPoolImplementation deployed at:", address(implementation));

        console.log("\n--- Deploying PortalPoolFactory ---");
        PortalPoolFactory factory = new PortalPoolFactory(
            address(implementation),
            address(portalRegistry),
            address(feeRouter),
            networkController,
            SQD,
            USDC,
            MAX_STAKE_PER_WALLET
        );
        console.log("PortalPoolFactory deployed at:", address(factory));
        console.log("PortalPoolBeacon deployed at:", address(factory.beacon()));

        console.log("\n--- Setting Factory in Registry ---");
        portalRegistry.setFactory(address(factory));
        console.log("Factory set in PortalRegistry");

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
    }
}
