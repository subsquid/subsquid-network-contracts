// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {FeeRouterModule} from "../../src/FeeRouterModule.sol";
import {MockNetworkController} from "../../test/mocks/MockNetworkController.sol";
import {MockERC20} from "../../test/mocks/MockERC20.sol";

contract DeploySepoliaWithTSQDAndMockUSDC is Script {
    // provided tSQD on Sepolia
    address public constant T_SQD = 0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c;
    // existing MockUSDC on Sepolia
    address public constant MOCK_USDC = 0x8baf8707861a84e3d978aC067447de9AAd862FAc;

    // configuration
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;
    address public constant WORKER_POOL = 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee;

    struct Deployed {
        address mockUsdc;
        address networkController;
        address portalRegistry;
        address feeRouter;
        address implementation;
        address factory;
        address beacon;
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("Deployer:", deployer);
        console.log("tSQD:", T_SQD);
        console.log("Using existing MockUSDC:", MOCK_USDC);

        vm.startBroadcast(pk);

        // use existing mock USDC instead of deploying new one
        d.mockUsdc = MOCK_USDC;

        d = _deployCore(deployer, T_SQD, d.mockUsdc);

        vm.stopBroadcast();
    }

    function _deployCore(address deployer, address sqd, address usdc) internal returns (Deployed memory d) {
        d.mockUsdc = usdc;

        MockNetworkController controller =
            new MockNetworkController(WORKER_EPOCH_LENGTH, MIN_STAKE_THRESHOLD, WORKER_POOL);
        d.networkController = address(controller);
        console.log("NetworkController:", d.networkController);

        PortalRegistry registry = new PortalRegistry(sqd, d.networkController, MIN_STAKE_THRESHOLD, MANA);
        d.portalRegistry = address(registry);
        console.log("PortalRegistry:", d.portalRegistry);

        FeeRouterModule feeRouter = new FeeRouterModule();
        d.feeRouter = address(feeRouter);
        console.log("FeeRouterModule:", d.feeRouter);

        PortalPoolImplementation impl = new PortalPoolImplementation();
        d.implementation = address(impl);
        console.log("PortalPoolImplementation:", d.implementation);

        PortalPoolFactory factory =
            new PortalPoolFactory(d.implementation, d.portalRegistry, d.feeRouter, d.networkController, sqd, MAX_STAKE_PER_WALLET);
        d.factory = address(factory);
        d.beacon = address(factory.beacon());
        console.log("PortalPoolFactory:", d.factory);
        console.log("PortalPoolBeacon:", d.beacon);

        registry.setFactory(d.factory);
        factory.setWorkerPoolAddress(WORKER_POOL);
        factory.addPaymentToken(usdc);

        return d;
    }
}

