// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {FeeRouterModule} from "../../src/FeeRouterModule.sol";
import {MockNetworkController} from "../../test/mocks/MockNetworkController.sol";
import {MockERC20} from "../../test/mocks/MockERC20.sol";

contract DeployArbitrumMocks is Script {
    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 public constant MANA = 1000;
    address public constant WORKER_POOL = 0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee;

    struct Deployed {
        address mockSqd;
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

        vm.startBroadcast(pk);

        MockERC20 sqd = new MockERC20("Mock SQD", "mSQD", 18);
        d.mockSqd = address(sqd);
        sqd.mint(deployer, 1_000_000_000 ether);
        console.log("Mock SQD:", d.mockSqd);

        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        d.mockUsdc = address(usdc);
        usdc.mint(deployer, 1_000_000_000 * 1e6);
        console.log("Mock USDC:", d.mockUsdc);

        d = _deployCore(deployer, d.mockSqd, d.mockUsdc);

        vm.stopBroadcast();
    }

    function _deployCore(address deployer, address sqd, address usdc) internal returns (Deployed memory d) {
        d.mockSqd = sqd;
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
            new PortalPoolFactory(d.implementation, d.portalRegistry, d.feeRouter, d.networkController, sqd, usdc, MAX_STAKE_PER_WALLET);
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

