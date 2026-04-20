// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {IPortalPool} from "../src/interfaces/IPortalPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPancakeRouter} from "./mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "./mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "./mocks/MockPancakePool.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract PortalPoolFactoryInitialSlippageTest is Test {
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant TICK_FOR_2X_PRICE = 6931;
    uint256 internal constant MIN_STAKE_THRESHOLD = 1 ether;
    uint256 internal constant MANA = 1000;
    uint256 internal constant DEFAULT_MAX_STAKE_PER_WALLET = 1_000_000 ether;
    uint256 internal constant WORKER_EPOCH_LENGTH = 7200;

    PortalPoolFactory internal factory;
    PortalRegistry internal registry;
    PortalPoolImplementation internal implementation;
    FeeRouterModuleV2 internal feeRouter;

    MockERC20 internal sqd;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockPancakeRouter internal pancakeRouter;
    MockPancakeFactory internal pancakeFactory;

    function setUp() public {
        sqd = new MockERC20("Subsquid", "SQD", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();
        pancakeFactory = new MockPancakeFactory();

        PortalRegistry registryImpl = new PortalRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, address(sqd), MIN_STAKE_THRESHOLD, MANA)
        );
        registry = PortalRegistry(address(registryProxy));

        feeRouter = new FeeRouterModuleV2(address(pancakeRouter), address(pancakeFactory), address(sqd), address(weth));
        feeRouter.configureBuyback(address(pancakeRouter), address(sqd), address(weth), 500, 10000);
        feeRouter.setAllowedRewardToken(address(usdc), true);
        feeRouter.setBuybackEnabled(true);
        feeRouter.setFeeConfig(5000, 0, 5000);

        implementation = new PortalPoolImplementation();

        PortalPoolFactory factoryImpl = new PortalPoolFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                address(implementation),
                address(registry),
                address(feeRouter),
                address(sqd),
                DEFAULT_MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        factory = PortalPoolFactory(address(factoryProxy));

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setMaxDistributionRate(type(uint256).max);
        factory.setPoolDeploymentOpen(true);

        usdc.mint(address(this), 1_000_000 * 1e6);
    }

    function test_CreatePortalPool_ExecutesImmediateBuybackOnInitialDeposit() public {
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(weth));
        MockPancakePool wethToSqdPool = _deployPool(address(weth), address(sqd));

        pancakeFactory.setPool(address(usdc), address(weth), 500, address(rewardToWethPool));
        pancakeFactory.setPool(address(weth), address(sqd), 10000, address(wethToSqdPool));

        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(weth), 0);
        _setReturnedTwapTick(wethToSqdPool, address(weth), address(sqd), 0);

        feeRouter.configureSlippageProtection(TWAP_WINDOW, 0);
        pancakeRouter.setRate(2, 1);

        IPortalFactory.CreatePortalPoolParams memory params = _defaultParams();
        usdc.approve(address(factory), params.initialDeposit);

        address portal = IPortalFactory(address(factory)).createPortalPool(params);

        assertEq(IPortalPool(portal).getCredit(), 50 * 1e6, "providers credit should stay in pool");
        assertEq(sqd.balanceOf(address(0xdead)), 100 * 1e6, "burn leg should buy and burn sqd immediately");
        assertEq(feeRouter.getPendingBuyback(address(usdc)), 0, "initial deposit should not leave pending buyback");
        assertEq(usdc.balanceOf(address(feeRouter)), 0, "router should not retain reward tokens");
    }

    function test_CreatePortalPool_UsesTwapFloorForInitialDepositBuyback() public {
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(weth));
        MockPancakePool wethToSqdPool = _deployPool(address(weth), address(sqd));

        pancakeFactory.setPool(address(usdc), address(weth), 500, address(rewardToWethPool));
        pancakeFactory.setPool(address(weth), address(sqd), 10000, address(wethToSqdPool));

        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(weth), 0);
        _setReturnedTwapTick(wethToSqdPool, address(weth), address(sqd), TICK_FOR_2X_PRICE);

        feeRouter.configureSlippageProtection(TWAP_WINDOW, 0);
        pancakeRouter.setRate(1, 1);

        IPortalFactory.CreatePortalPoolParams memory params = _defaultParams();
        usdc.approve(address(factory), params.initialDeposit);

        vm.expectRevert("MockRouter: insufficient output");
        IPortalFactory(address(factory)).createPortalPool(params);
    }

    function _defaultParams() internal view returns (IPortalFactory.CreatePortalPoolParams memory params) {
        params = IPortalFactory.CreatePortalPoolParams({
            operator: address(this),
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "slippage-pool",
            distributionRatePerSecond: 1_000_000,
            initialDeposit: 100 * 1e6,
            metadata: "",
            rewardToken: address(usdc)
        });
    }

    function _deployPool(address tokenA, address tokenB) internal returns (MockPancakePool pool) {
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = tokenA < tokenB ? tokenB : tokenA;
        pool = new MockPancakePool(token0, token1);
    }

    function _setReturnedTwapTick(MockPancakePool pool, address tokenA, address tokenB, int24 returnedTick) internal {
        int24 rawPoolTick = tokenA > tokenB ? -returnedTick : returnedTick;
        int56 cumulativeNow = int56(int256(rawPoolTick)) * int56(uint56(TWAP_WINDOW));
        pool.setTickCumulatives(0, cumulativeNow);
    }
}
