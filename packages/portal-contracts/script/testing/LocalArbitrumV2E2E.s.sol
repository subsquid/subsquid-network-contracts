// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PortalPoolFactory} from "../../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {FeeRouterModuleV2} from "../../src/FeeRouterModuleV2.sol";
import {IPortalFactory} from "../../src/interfaces/IPortalFactory.sol";
import {IPortalPool} from "../../src/interfaces/IPortalPool.sol";
import {MockERC20} from "../../test/mocks/MockERC20.sol";
import {MockPancakeRouter} from "../../test/mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "../../test/mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "../../test/mocks/MockPancakePool.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract LocalArbitrumV2E2E is Script {
    uint256 internal constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 internal constant MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 internal constant WORKER_EPOCH_LENGTH = 7200;
    uint256 internal constant MANA = 1000;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint256 internal constant INITIAL_DEPOSIT = 100 * 1e6;
    uint256 internal constant TOP_UP = 200 * 1e6;
    uint256 internal constant DISTRIBUTION_RATE = 1_000_000;
    address internal constant WORKER_POOL = address(0xBEEF);

    function run() external returns (address portal) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        require(block.chainid == 42161, "Run this script on local Arbitrum-chainid Anvil");

        vm.startBroadcast(deployerPrivateKey);

        MockERC20 sqd = new MockERC20("Mock SQD", "mSQD", 18);
        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        MockERC20 weth = new MockERC20("Mock WETH", "mWETH", 18);
        MockPancakeRouter pancakeRouter = new MockPancakeRouter();
        MockPancakeFactory pancakeFactory = new MockPancakeFactory();

        sqd.mint(deployer, 10_000_000 ether);
        usdc.mint(deployer, 10_000_000 * 1e6);

        pancakeRouter.setRate(2, 1);
        _configureOneToOneTwap(pancakeFactory, usdc, weth, sqd);

        PortalRegistry registry = _deployRegistry(address(sqd));
        FeeRouterModuleV2 feeRouter = _deployFeeRouter(address(pancakeRouter), address(pancakeFactory), sqd, usdc, weth);
        PortalPoolFactory factory = _deployFactory(registry, feeRouter, sqd);

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setMaxDistributionRate(type(uint256).max);
        factory.setPoolDeploymentOpen(true);

        usdc.approve(address(factory), INITIAL_DEPOSIT);
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: deployer,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "anvil-arb-v2",
            distributionRatePerSecond: DISTRIBUTION_RATE,
            initialDeposit: INITIAL_DEPOSIT,
            metadata: "Local Arbitrum V2 E2E",
            rewardToken: address(usdc)
        });

        portal = factory.createPortalPool(params);

        require(IPortalPool(portal).getState() == IPortalPool.PoolState.COLLECTING, "pool should start collecting");
        require(IPortalPool(portal).getCredit() == 50 * 1e6, "initial provider credit mismatch");
        require(sqd.balanceOf(WORKER_POOL) == 90 * 1e6, "initial worker SQD mismatch");
        require(sqd.balanceOf(address(0xdead)) == 10 * 1e6, "initial burn SQD mismatch");
        require(feeRouter.getPendingBuyback(address(usdc)) == 0, "router should not retain USDC");

        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);

        require(IPortalPool(portal).getState() == IPortalPool.PoolState.ACTIVE, "pool should activate after deposit");

        usdc.approve(portal, TOP_UP);
        IPortalPool(portal).topUpRewards(TOP_UP);

        require(IPortalPool(portal).getCredit() == 150 * 1e6, "credit after top up mismatch");
        require(sqd.balanceOf(WORKER_POOL) == 270 * 1e6, "worker SQD after top up mismatch");
        require(sqd.balanceOf(address(0xdead)) == 30 * 1e6, "burn SQD after top up mismatch");
        require(feeRouter.getPendingBuyback(address(usdc)) == 0, "router should remain empty after top up");

        vm.stopBroadcast();

        console.log("Local Arbitrum V2 E2E OK");
        console.log("Portal:", portal);
        console.log("Registry:", address(registry));
        console.log("Factory:", address(factory));
        console.log("FeeRouterV2:", address(feeRouter));
    }

    function _deployRegistry(address sqd) internal returns (PortalRegistry registry) {
        PortalRegistry registryImpl = new PortalRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, sqd, MIN_STAKE_THRESHOLD, MANA)
        );
        registry = PortalRegistry(address(registryProxy));
    }

    function _deployFeeRouter(
        address pancakeRouter,
        address pancakeFactory,
        MockERC20 sqd,
        MockERC20 usdc,
        MockERC20 weth
    ) internal returns (FeeRouterModuleV2 feeRouter) {
        feeRouter = new FeeRouterModuleV2(pancakeRouter, pancakeFactory, address(sqd), address(weth));
        feeRouter.configureBuyback(pancakeRouter, address(sqd), address(weth), 2500, 2500);
        feeRouter.setWorkerPoolAddress(WORKER_POOL);
        feeRouter.setAllowedRewardToken(address(usdc), true);
        feeRouter.setBuybackEnabled(true);
        feeRouter.setFeeConfig(5000, 4500, 500);
        feeRouter.configureSlippageProtection(TWAP_WINDOW, 300);
    }

    function _deployFactory(PortalRegistry registry, FeeRouterModuleV2 feeRouter, MockERC20 sqd)
        internal
        returns (PortalPoolFactory factory)
    {
        PortalPoolImplementation implementation = new PortalPoolImplementation();
        PortalPoolFactory factoryImpl = new PortalPoolFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                address(implementation),
                address(registry),
                address(feeRouter),
                address(sqd),
                MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        factory = PortalPoolFactory(address(factoryProxy));
    }

    function _configureOneToOneTwap(MockPancakeFactory pancakeFactory, MockERC20 usdc, MockERC20 weth, MockERC20 sqd)
        internal
    {
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(weth));
        MockPancakePool wethToSqdPool = _deployPool(address(weth), address(sqd));

        pancakeFactory.setPool(address(usdc), address(weth), 2500, address(rewardToWethPool));
        pancakeFactory.setPool(address(weth), address(sqd), 2500, address(wethToSqdPool));

        rewardToWethPool.setTickCumulatives(0, 0);
        wethToSqdPool.setTickCumulatives(0, 0);
    }

    function _deployPool(address tokenA, address tokenB) internal returns (MockPancakePool pool) {
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = tokenA < tokenB ? tokenB : tokenA;
        pool = new MockPancakePool(token0, token1);
    }
}
