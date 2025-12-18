// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "../test/mocks/MockNetworkController.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

contract DeployPortalSystem is Script {
    // Default configuration values
    uint256 public constant DEFAULT_WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant DEFAULT_MIN_STAKE_THRESHOLD = 1_000_000 ether; // 1M SQD
    uint256 public constant DEFAULT_MAX_POOL_CAPACITY = 1_200_000 ether; // 1.2M SQD
    uint256 public constant DEFAULT_MANA = 1000;
    uint256 public constant DEFAULT_MAX_STAKE_PER_WALLET = 100_000 ether; // 100K SQD
    address public constant DEFAULT_WORKER_REWARD_POOL = address(0x1234567890123456789012345678901234567890);

    struct Deployed {
        address sqd;
        address usdc;
        address dai;
        address networkController;
        address portalRegistry;
        address feeRouter;
        address implementation;
        address factory;
        address beacon;
    }

    struct Config {
        uint256 workerEpochLength;
        uint256 minStakeThreshold;
        uint256 maxPoolCapacity;
        uint256 maxStakePerWallet;
        uint256 mana;
        address workerRewardPool;
    }

    function run() external {
        _startBroadcast();

        Config memory cfg = _loadConfig();
        Deployed memory d = _deployAll(cfg);
        _printSummary(d, cfg);

        vm.stopBroadcast();
    }

    function _startBroadcast() internal {
        try vm.envUint("PRIVATE_KEY") returns (uint256 key) {
            vm.startBroadcast(key);
        } catch {
            console.log("No PRIVATE_KEY found, using default account for local testing");
            vm.startBroadcast();
        }
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.workerEpochLength = _getEnvUint("WORKER_EPOCH_LENGTH", DEFAULT_WORKER_EPOCH_LENGTH);
        cfg.minStakeThreshold = _getEnvUint("MIN_STAKE_THRESHOLD", DEFAULT_MIN_STAKE_THRESHOLD);
        cfg.maxPoolCapacity = _getEnvUint("MAX_POOL_CAPACITY", DEFAULT_MAX_POOL_CAPACITY);
        cfg.maxStakePerWallet = _getEnvUint("MAX_STAKE_PER_WALLET", DEFAULT_MAX_STAKE_PER_WALLET);
        cfg.mana = _getEnvUint("MANA", DEFAULT_MANA);
        cfg.workerRewardPool = _getEnvAddress("WORKER_REWARD_POOL", DEFAULT_WORKER_REWARD_POOL);
    }

    function _deployAll(Config memory cfg) internal returns (Deployed memory d) {
        // Deploy tokens
        d.sqd = address(new MockERC20("Subsquid", "SQD", 18));
        d.usdc = address(new MockERC20("USD Coin", "USDC", 6));
        d.dai = address(new MockERC20("Dai Stablecoin", "DAI", 18));

        // Deploy core contracts
        d.networkController = address(
            new MockNetworkController(cfg.workerEpochLength, cfg.minStakeThreshold, cfg.workerRewardPool)
        );
        d.portalRegistry = address(
            new PortalRegistry(d.sqd, d.networkController, cfg.minStakeThreshold, cfg.mana)
        );
        d.feeRouter = address(new FeeRouterModule());
        d.implementation = address(new PortalPoolImplementation());

        // Deploy factory
        PortalPoolFactory factory = new PortalPoolFactory(
            d.implementation,
            d.portalRegistry,
            d.feeRouter,
            d.networkController,
            d.sqd,
            d.usdc,
            cfg.maxPoolCapacity,
            cfg.maxStakePerWallet
        );
        d.factory = address(factory);
        d.beacon = address(factory.beacon());
    }

    function _printSummary(Deployed memory d, Config memory cfg) internal pure {
        console.log("\n=== Deployment Summary ===");
        console.log("SQD Token:", d.sqd);
        console.log("USDC Token:", d.usdc);
        console.log("DAI Token:", d.dai);
        console.log("NetworkController:", d.networkController);
        console.log("PortalRegistry:", d.portalRegistry);
        console.log("FeeRouterModule:", d.feeRouter);
        console.log("PortalPoolImplementation:", d.implementation);
        console.log("PortalPoolFactory:", d.factory);
        console.log("PortalPoolBeacon:", d.beacon);
        console.log("\n=== Configuration ===");
        console.log("Worker Epoch Length:", cfg.workerEpochLength);
        console.log("Min Stake Threshold:", cfg.minStakeThreshold);
        console.log("Max Pool Capacity:", cfg.maxPoolCapacity);
        console.log("Max Stake Per Wallet:", cfg.maxStakePerWallet);
        console.log("Mana:", cfg.mana);
        console.log("Worker Reward Pool:", cfg.workerRewardPool);
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
