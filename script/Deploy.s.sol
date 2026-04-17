// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployPortalSystem is Script {
    // Arbitrum Sepolia token addresses
    address public constant SQD = 0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c;
    address public constant USDC = 0x8baf8707861a84e3d978aC067447de9AAd862FAc;
    address public constant WETH = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
    address public constant PANCAKE_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant WORKER_POOL = 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee;

    // Additional admin to be granted roles after deployment
    address public constant ADDITIONAL_ADMIN = 0x2A2fBDef84219BdAa0C657e45447D6BDd7EDAaE2;

    // Configuration values
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;
    uint24 public constant REWARD_TO_WETH_POOL_FEE = 2500;
    uint24 public constant WETH_TO_SQD_POOL_FEE = 2500;
    uint256 public constant INITIAL_POOL_CAPACITY = MIN_STAKE_THRESHOLD;
    uint256 public constant INITIAL_POOL_DAILY_REWARDS = 100 * 1e6;
    string public constant INITIAL_POOL_SUFFIX = "ARBSEP-V2";
    string public constant INITIAL_POOL_METADATA = "Arbitrum Sepolia V2 bootstrap pool";

    struct DeployedContracts {
        address portalRegistry;
        address feeRouter;
        address implementation;
        address factory;
        address beacon;
        address initialPool;
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

        console.log("\n--- Deploying FeeRouterModuleV2 ---");
        FeeRouterModuleV2 feeRouter = new FeeRouterModuleV2();
        d.feeRouter = address(feeRouter);
        console.log("FeeRouterModuleV2 deployed at:", d.feeRouter);

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

        console.log("\n--- Configuring FeeRouterModuleV2 ---");
        feeRouter.setWorkerPoolAddress(WORKER_POOL);
        feeRouter.setAllowedRewardToken(USDC, true);
        feeRouter.configureBuyback(PANCAKE_V3_ROUTER, SQD, WETH, REWARD_TO_WETH_POOL_FEE, WETH_TO_SQD_POOL_FEE);
        feeRouter.setBuybackEnabled(true);
        feeRouter.setFeeConfig(10000, 0, 0);
        console.log("Worker pool address set on FeeRouter to:", WORKER_POOL);
        console.log("USDC allowed on FeeRouter");
        console.log("Buyback endpoints configured for future liquidity");
        console.log("Fee config set to 100% providers until Sepolia liquidity exists");

        console.log("\n--- Adding Payment Tokens ---");
        factory.addPaymentToken(USDC);
        console.log("USDC added as payment token");

        console.log("\n--- Creating Initial Pool ---");
        uint256 distributionRatePerSecond = _rateFromDailyReward(INITIAL_POOL_DAILY_REWARDS);
        uint256 initialDeposit = distributionRatePerSecond * 1 days / 1000;
        IERC20(USDC).approve(address(factory), initialDeposit);
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: ADDITIONAL_ADMIN,
            capacity: INITIAL_POOL_CAPACITY,
            tokenSuffix: INITIAL_POOL_SUFFIX,
            distributionRatePerSecond: distributionRatePerSecond,
            initialDeposit: initialDeposit,
            metadata: INITIAL_POOL_METADATA,
            rewardToken: USDC
        });
        d.initialPool = factory.createPortalPool(params);
        console.log("Initial pool created at:", d.initialPool);

        console.log("\n--- Verifying Configuration ---");
        require(factory.sqd() == SQD, "SQD address mismatch");
        require(factory.isAllowedPaymentToken(USDC), "USDC not added as payment token");
        require(portalRegistry.factory() == d.factory, "Factory not set in registry");
        require(feeRouter.getWorkerPoolAddress() == WORKER_POOL, "Worker pool address not set on FeeRouter");
        require(factory.minStakeThreshold() == MIN_STAKE_THRESHOLD, "Min stake threshold mismatch");
        require(factory.workerEpochLength() == WORKER_EPOCH_LENGTH, "Worker epoch length mismatch");
        require(factory.isPortal(d.initialPool), "Initial pool not registered");
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

    function _rateFromDailyReward(uint256 dailyReward) internal pure returns (uint256) {
        return (dailyReward * 1000 + 1 days - 1) / 1 days;
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
        console.log("  FeeRouterModuleV2:", d.feeRouter);
        console.log("");
        console.log("Factory System:");
        console.log("  PortalPoolImplementation:", d.implementation);
        console.log("  PortalPoolFactory:", d.factory);
        console.log("  PortalPoolBeacon:", d.beacon);
        console.log("  Initial Pool:", d.initialPool);
        console.log("");
        console.log("Configuration:");
        console.log("  Min Stake Threshold:", MIN_STAKE_THRESHOLD / 1e18, "SQD");
        console.log("  Max Pool Capacity:", MAX_POOL_CAPACITY / 1e18, "SQD");
        console.log("  Max Stake Per Wallet:", MAX_STAKE_PER_WALLET / 1e18, "SQD");
        console.log("  Worker Epoch Length:", WORKER_EPOCH_LENGTH);
        console.log("  Mana:", MANA);
        console.log("  Worker Pool Address:", WORKER_POOL);
        console.log("  Pancake V3 Router:", PANCAKE_V3_ROUTER);
        console.log("  WETH:", WETH);
        console.log("  Initial Pool Operator:", ADDITIONAL_ADMIN);
        console.log("  Initial Pool Capacity:", INITIAL_POOL_CAPACITY / 1e18, "SQD");
        console.log("  Initial Pool Daily Rewards:", INITIAL_POOL_DAILY_REWARDS / 1e6, "USDC/day");
        console.log("  Fee Router Mode: 100% providers until SQD liquidity exists on Pancake V3");
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

    address public constant WORKER_POOL = 0x1291847E44A9144306CABA8B83504E1430C92E66;
    address public constant POOL_DEPLOYER_1 = 0x2A2fBDef84219BdAa0C657e45447D6BDd7EDAaE2;
    address public constant POOL_DEPLOYER_2 = 0xc423362be9db384B79B7A8b21d68B65E3f1c63a7;

    uint256 public constant MIN_STAKE_THRESHOLD = 1_000_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 100_000 ether;
    uint256 public constant MANA = 1000;
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("SQD:", SQD);
        console.log("USDC:", USDC);

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

        console.log("\n--- Adding USDC as Payment Token ---");
        factory.addPaymentToken(USDC);
        console.log("USDC added as payment token");

        console.log("\n--- Setting Worker Pool Address on FeeRouter ---");
        feeRouter.setWorkerPoolAddress(WORKER_POOL);
        console.log("Worker pool address set on FeeRouter to:", WORKER_POOL);

        console.log("\n--- Enabling Default Whitelist ---");
        factory.setDefaultWhitelistEnabled(true);
        console.log("Default whitelist enabled");

        console.log("\n--- Granting Roles ---");

        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_1);
        factory.grantRole(factory.POOL_DEPLOYER_ROLE(), POOL_DEPLOYER_1);
        console.log("Granted DEFAULT_ADMIN_ROLE and POOL_DEPLOYER_ROLE to:", POOL_DEPLOYER_1);

        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_2);
        factory.grantRole(factory.POOL_DEPLOYER_ROLE(), POOL_DEPLOYER_2);
        console.log("Granted DEFAULT_ADMIN_ROLE and POOL_DEPLOYER_ROLE to:", POOL_DEPLOYER_2);

        portalRegistry.grantRole(portalRegistry.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_1);
        portalRegistry.grantRole(portalRegistry.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_2);
        console.log("Granted DEFAULT_ADMIN_ROLE on Registry to both deployers");

        feeRouter.grantRole(feeRouter.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_1);
        feeRouter.grantRole(feeRouter.DEFAULT_ADMIN_ROLE(), POOL_DEPLOYER_2);
        console.log("Granted DEFAULT_ADMIN_ROLE on FeeRouter to both deployers");

        vm.stopBroadcast();

        console.log("\n========================================");
        console.log("       DEPLOYMENT SUMMARY");
        console.log("========================================");
        console.log("PortalRegistry:", address(portalRegistry));
        console.log("FeeRouterModule:", address(feeRouter));
        console.log("PortalPoolImplementation:", address(implementation));
        console.log("PortalPoolFactory:", address(factory));
        console.log("PortalPoolBeacon:", address(factory.beacon()));
        console.log("");
        console.log("Configuration:");
        console.log("  Min Stake Threshold: 1,000,000 SQD");
        console.log("  Max Stake Per Wallet: 100,000 SQD");
        console.log("  Worker Epoch Length:", WORKER_EPOCH_LENGTH);
        console.log("  Default Whitelist: ENABLED");
        console.log("  Worker Pool:", WORKER_POOL);
        console.log("");
        console.log("Pool Deployers:");
        console.log("  ", deployer);
        console.log("  ", POOL_DEPLOYER_1);
        console.log("  ", POOL_DEPLOYER_2);
        console.log("========================================");
    }
}
