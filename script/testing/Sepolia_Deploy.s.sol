// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {PortalPoolFactory} from "../../src/PortalPoolFactory.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {FeeRouterModule} from "../../src/FeeRouterModule.sol";
import {MockERC20} from "../../test/mocks/MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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

        PortalRegistry registryImpl = new PortalRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, sqd, MIN_STAKE_THRESHOLD, MANA)
        );
        PortalRegistry registry = PortalRegistry(address(registryProxy));
        d.portalRegistry = address(registry);
        console.log("PortalRegistry impl:", address(registryImpl));
        console.log("PortalRegistry proxy:", d.portalRegistry);

        FeeRouterModule feeRouter = new FeeRouterModule();
        d.feeRouter = address(feeRouter);
        console.log("FeeRouterModule:", d.feeRouter);

        PortalPoolImplementation impl = new PortalPoolImplementation();
        d.implementation = address(impl);
        console.log("PortalPoolImplementation:", d.implementation);

        PortalPoolFactory factoryImpl = new PortalPoolFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                d.implementation,
                d.portalRegistry,
                d.feeRouter,
                sqd,
                MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        PortalPoolFactory factory = PortalPoolFactory(address(factoryProxy));
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
