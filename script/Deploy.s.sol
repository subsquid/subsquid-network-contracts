// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployPortalSystem is Script {
    // Arbitrum Sepolia token addresses
    address public constant SQD = 0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c;
    address public constant USDC = 0x8baf8707861a84e3d978aC067447de9AAd862FAc;

    // Additional admin to be granted roles after deployment
    address public constant ADDITIONAL_ADMIN = 0x2A2fBDef84219BdAa0C657e45447D6BDd7EDAaE2;

    // Configuration values
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;

    struct DeployedContracts {
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

        console.log("\n--- Deploying PortalRegistry ---");
        PortalRegistry portalRegistryImpl = new PortalRegistry();
        ERC1967Proxy portalRegistryProxy = new ERC1967Proxy(
            address(portalRegistryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, SQD, MIN_STAKE_THRESHOLD, MANA)
        );
        PortalRegistry portalRegistry = PortalRegistry(address(portalRegistryProxy));
        d.portalRegistry = address(portalRegistry);
        console.log("PortalRegistry implementation:", address(portalRegistryImpl));
        console.log("PortalRegistry proxy:", d.portalRegistry);

        console.log("\n--- Deploying FeeRouterModule ---");
        FeeRouterModule feeRouter = new FeeRouterModule();
        d.feeRouter = address(feeRouter);
        console.log("FeeRouterModule deployed at:", d.feeRouter);

        console.log("\n--- Deploying PortalPoolImplementation ---");
        PortalPoolImplementation implementation = new PortalPoolImplementation();
        d.implementation = address(implementation);
        console.log("PortalPoolImplementation deployed at:", d.implementation);

        console.log("\n--- Deploying PortalPoolFactory ---");
        PortalPoolFactory factoryImpl = new PortalPoolFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                d.implementation,
                d.portalRegistry,
                d.feeRouter,
                SQD,
                MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        PortalPoolFactory factory = PortalPoolFactory(address(factoryProxy));
        d.factory = address(factory);
        d.beacon = address(factory.beacon());
        console.log("PortalPoolFactory deployed at:", d.factory);
        console.log("PortalPoolBeacon deployed at:", d.beacon);

        console.log("\n--- Setting Factory in Registry ---");
        portalRegistry.setFactory(d.factory);
        console.log("Factory set in PortalRegistry");

        console.log("\n--- Setting Worker Pool Address on FeeRouter ---");
        FeeRouterModule(d.feeRouter).setWorkerPoolAddress(workerRewardPool);
        console.log("Worker pool address set on FeeRouter to:", workerRewardPool);

        console.log("\n--- Adding Payment Tokens ---");
        factory.addPaymentToken(USDC);
        console.log("USDC added as payment token");

        console.log("\n--- Verifying Configuration ---");
        require(factory.sqd() == SQD, "SQD address mismatch");
        require(factory.isAllowedPaymentToken(USDC), "USDC not added as payment token");
        require(portalRegistry.factory() == d.factory, "Factory not set in registry");
        require(FeeRouterModule(d.feeRouter).getWorkerPoolAddress() == workerRewardPool, "Worker pool address not set on FeeRouter");
        require(factory.minStakeThreshold() == MIN_STAKE_THRESHOLD, "Min stake threshold mismatch");
        require(factory.workerEpochLength() == WORKER_EPOCH_LENGTH, "Worker epoch length mismatch");
        console.log("Configuration verified successfully");

        console.log("\n--- Granting Roles to Additional Admin ---");
        console.log("Additional Admin:", ADDITIONAL_ADMIN);

        // Grant admin role on Factory
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on Factory");

        // Grant pool deployer role on Factory
        factory.grantRole(factory.POOL_DEPLOYER_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted POOL_DEPLOYER_ROLE on Factory");

        // Grant admin role on Registry
        portalRegistry.grantRole(portalRegistry.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on Registry");

        // Grant admin role on FeeRouter
        feeRouter.grantRole(feeRouter.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on FeeRouter");
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
        console.log("  Worker Epoch Length:", WORKER_EPOCH_LENGTH);
        console.log("  Mana:", MANA);
        console.log("  Worker Pool Address: 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee");
        console.log("");
        console.log("Additional Admin:");
        console.log("  Address:", ADDITIONAL_ADMIN);
        console.log("  Roles: DEFAULT_ADMIN_ROLE, POOL_DEPLOYER_ROLE (Factory)");
        console.log("  Roles: DEFAULT_ADMIN_ROLE (Registry)");
        console.log("  Roles: DEFAULT_ADMIN_ROLE (FeeRouter)");
        console.log("========================================");
    }
}

contract DeployArbitrum is Script {
    address public constant SQD = 0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    // Additional admin to be granted roles after deployment
    address public constant ADDITIONAL_ADMIN = 0x2A2fBDef84219BdAa0C657e45447D6BDd7EDAaE2;

    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        console.log("\n--- Deploying PortalRegistry ---");
        PortalRegistry portalRegistryImpl = new PortalRegistry();
        ERC1967Proxy portalRegistryProxy = new ERC1967Proxy(
            address(portalRegistryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, SQD, MIN_STAKE_THRESHOLD, MANA)
        );
        PortalRegistry portalRegistry = PortalRegistry(address(portalRegistryProxy));
        console.log("PortalRegistry implementation:", address(portalRegistryImpl));
        console.log("PortalRegistry proxy:", address(portalRegistry));

        console.log("\n--- Deploying FeeRouterModule ---");
        FeeRouterModule feeRouter = new FeeRouterModule();
        console.log("FeeRouterModule deployed at:", address(feeRouter));

        console.log("\n--- Deploying PortalPoolImplementation ---");
        PortalPoolImplementation implementation = new PortalPoolImplementation();
        console.log("PortalPoolImplementation deployed at:", address(implementation));

        console.log("\n--- Deploying PortalPoolFactory ---");
        PortalPoolFactory factoryImpl = new PortalPoolFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                address(implementation),
                address(portalRegistry),
                address(feeRouter),
                SQD,
                MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        PortalPoolFactory factory = PortalPoolFactory(address(factoryProxy));
        console.log("PortalPoolFactory deployed at:", address(factory));
        console.log("PortalPoolBeacon deployed at:", address(factory.beacon()));

        console.log("\n--- Setting Factory in Registry ---");
        portalRegistry.setFactory(address(factory));
        console.log("Factory set in PortalRegistry");

        console.log("\n--- Setting Worker Pool Address on FeeRouter ---");
        address workerRewardPool = 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee;
        feeRouter.setWorkerPoolAddress(workerRewardPool);
        console.log("Worker pool address set on FeeRouter to:", workerRewardPool);

        console.log("\n--- Granting Roles to Additional Admin ---");
        console.log("Additional Admin:", ADDITIONAL_ADMIN);

        // Grant admin role on Factory
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on Factory");

        // Grant pool deployer role on Factory
        factory.grantRole(factory.POOL_DEPLOYER_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted POOL_DEPLOYER_ROLE on Factory");

        // Grant admin role on Registry
        portalRegistry.grantRole(portalRegistry.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on Registry");

        // Grant admin role on FeeRouter
        feeRouter.grantRole(feeRouter.DEFAULT_ADMIN_ROLE(), ADDITIONAL_ADMIN);
        console.log("Granted DEFAULT_ADMIN_ROLE on FeeRouter");

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
    }
}
