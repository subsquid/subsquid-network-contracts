// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {IPortalPool} from "../src/interfaces/IPortalPool.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {Constants} from "../src/libs/Constants.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RatePrecisionE2ETest is Test {
    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;

    MockERC20 public sqd;
    MockERC20 public usdc;

    address public admin = address(this);
    address public operator = address(0x1);
    address public alice = address(0x2);
    address public bob = address(0x3);
    address public workerRewardPool = address(0x5);

    uint256 constant MIN_STAKE = 1_000_000;
    uint256 constant CAPACITY = 2_000_000;
    uint256 constant MANA = 1000;
    uint256 constant MAX_STAKE_PER_WALLET = 10_000_000;
    uint256 constant RATE_PRECISION = 1000;
    uint256 constant WORKER_EPOCH_LENGTH = 7200;

    uint256 poolCount;

    function setUp() public {
        sqd = new MockERC20("Subsquid", "SQD", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        PortalRegistry registryImpl = new PortalRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, address(sqd), MIN_STAKE, MANA)
        );
        registry = PortalRegistry(address(registryProxy));
        feeRouter = new FeeRouterModule();
        feeRouter.setFeeConfig(10000, 0, 0);

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
                MAX_STAKE_PER_WALLET,
                MIN_STAKE,
                WORKER_EPOCH_LENGTH
            )
        );
        factory = PortalPoolFactory(address(factoryProxy));

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setWorkerPoolAddress(workerRewardPool);
        factory.setDefaultWhitelistEnabled(false);

        sqd.mint(operator, 100_000_000);
        sqd.mint(alice, 10_000_000);
        sqd.mint(bob, 10_000_000);
        usdc.mint(admin, type(uint128).max);
        usdc.mint(operator, type(uint128).max);
    }

    function _createPool(uint256 scaledRate) internal returns (PortalPoolImplementation) {
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-", poolCount),
            tokenSuffix: string(abi.encodePacked("TEST", poolCount)),
            distributionRatePerSecond: scaledRate,
            metadata: "",
            rewardToken: address(usdc)
        });

        if (scaledRate > 0) {
            uint256 initialDeposit = scaledRate * 1 days / RATE_PRECISION;
            if (usdc.balanceOf(admin) < initialDeposit) {
                usdc.mint(admin, initialDeposit);
            }
            usdc.approve(address(factory), initialDeposit);
        }

        address portalAddress = factory.createPortalPool(params);
        PortalPoolImplementation pool = PortalPoolImplementation(portalAddress);

        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY);
        pool.deposit(CAPACITY);
        vm.stopPrank();

        return pool;
    }

    function test_E2E_SingleTokenFee_MinimumRate() public {
        uint256 scaledRate = 1000; // 1 token/sec (minimum allowed)
        PortalPoolImplementation pool = _createPool(scaledRate);

        vm.startPrank(operator);
        usdc.approve(address(pool), 100_000);
        pool.topUpRewards(100_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 10);

        uint256 claimable = pool.getClaimableRewards(alice);
        uint256 expectedActual = (1000 * 10) / RATE_PRECISION; // 10 tokens for 10 seconds at 1/sec

        assertEq(claimable, expectedActual, "Minimum rate precision: should get 10 tokens");
    }

    function test_E2E_PrecisionLoss_SmallTimeSmallRate() public {
        uint256 scaledRate = 1000; // 1 token/sec (minimum allowed)
        PortalPoolImplementation pool = _createPool(scaledRate);

        vm.startPrank(operator);
        usdc.approve(address(pool), 100_000);
        pool.topUpRewards(100_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 1); // 1 second

        uint256 claimable = pool.getClaimableRewards(alice);
        // At 1 token/sec for 1 second = 1 token
        assertEq(claimable, 1, "Precision: 1 second at min rate = 1 token");
    }

    function test_E2E_DrainRate_PartialStake_Precision() public {
        uint256 scaledRate = 100 * RATE_PRECISION; // 100 tokens/sec
        PortalPoolImplementation pool = _createPool(scaledRate);

        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        vm.stopPrank();

        // Alice has 100% stake, drain rate should equal full rate
        uint256 drainRate = pool.getTotalDrainRate();
        assertEq(drainRate, scaledRate, "Full stake: drain rate equals distribution rate");

        // Create exit request for half
        vm.prank(alice);
        pool.requestExit(CAPACITY / 2);

        // Now active stake is 50%, drain should be 50%
        uint256 drainRateAfter = pool.getTotalDrainRate();
        uint256 expectedDrain = scaledRate / 2;
        assertEq(drainRateAfter, expectedDrain, "Half stake: drain rate is 50%");
    }

    function test_E2E_Runway_Precision_SmallCredit() public {
        uint256 scaledRate = 1000 * RATE_PRECISION; // 1000 tokens/sec
        PortalPoolImplementation pool = _createPool(scaledRate);

        // Initial credit from pool creation: scaledRate * 86400 / 1000 = 86,400,000 tokens
        // Drain rate = 1000 tokens/sec
        // Initial runway = 86,400,000 / 1000 = 86,400 seconds = 1 day

        // Top up exactly 1000 tokens (1 second of runway)
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        // Total credit = 86,400,000 + 1000 = 86,401,000
        // Total runway = 86,401,000 / 1000 = 86,401 seconds
        int256 runway = pool.getRunway();
        int256 expectedRunway = int256(block.timestamp) + 86401;

        assertEq(runway, expectedRunway, "Runway: accounts for initial deposit + topup");
    }

    function test_E2E_RateChange_NoDebtManipulation() public {
        uint256 scaledRate = 100 * RATE_PRECISION;
        PortalPoolImplementation pool = _createPool(scaledRate);

        // Initial credit from pool creation: scaledRate * 86400 / 1000 = 8,640,000
        // Need to exhaust that plus any top-up to get into debt
        // Don't top up - just let initial credit drain

        // Drain rate = 100 tokens/sec, initial credit = 8,640,000
        // Time to debt = 8,640,000 / 100 = 86,400 seconds + 1
        vm.warp(block.timestamp + 86401);

        // Try to change rate while in debt - should revert
        vm.prank(operator);
        vm.expectRevert(PortalErrors.PoolHasDebt.selector);
        pool.setDistributionRate(50 * RATE_PRECISION);
    }

    function test_E2E_ExtremeRates_MaxAndMin() public {
        // Test minimum rate (1000 = 1 token/sec, minimum allowed)
        PortalPoolImplementation poolMin = _createPool(1000);
        assertEq(poolMin.totalDistributionRatePerSec(), 1000, "Min rate stored correctly");
        assertTrue(poolMin.perStakeRateWad() > 0, "Min rate: perStakeRateWad > 0");

        // Test high rate near max
        uint256 highRate = 1e9; // 1M tokens/sec (within max)
        PortalPoolImplementation poolHigh = _createPool(highRate);
        assertEq(poolHigh.totalDistributionRatePerSec(), highRate, "High rate stored correctly");

        // Test that rate below minimum reverts
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-below-min-", poolCount),
            tokenSuffix: string(abi.encodePacked("BMIN", poolCount)),
            distributionRatePerSecond: 999, // Just below minimum
            metadata: "",
            rewardToken: address(usdc)
        });
        vm.expectRevert(PortalErrors.RateBelowMinimum.selector);
        factory.createPortalPool(params);
    }

    function test_E2E_MultiUser_PrecisionFairness() public {
        uint256 scaledRate = 3 * RATE_PRECISION; // 3 tokens/sec (not divisible by 2)

        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-multi-", poolCount),
            tokenSuffix: "MULTI",
            distributionRatePerSecond: scaledRate,
            metadata: "",
            rewardToken: address(usdc)
        });

        uint256 initialDeposit = scaledRate * 1 days / RATE_PRECISION;
        usdc.approve(address(factory), initialDeposit);
        address portalAddress = factory.createPortalPool(params);
        PortalPoolImplementation pool = PortalPoolImplementation(portalAddress);

        // Alice and Bob each stake 50%
        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY / 2);
        pool.deposit(CAPACITY / 2);
        vm.stopPrank();

        vm.startPrank(bob);
        sqd.approve(portalAddress, CAPACITY / 2);
        pool.deposit(CAPACITY / 2);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 aliceRewards = pool.getClaimableRewards(alice);
        uint256 bobRewards = pool.getClaimableRewards(bob);

        // 3 tokens/sec * 100 sec = 300 tokens total
        // Each should get 150 (300/2)
        assertEq(aliceRewards, 150, "Alice gets half");
        assertEq(bobRewards, 150, "Bob gets half");
        assertEq(aliceRewards + bobRewards, 300, "Total is exact");
    }

    function test_E2E_CreditDebt_TransitionPrecision() public {
        uint256 scaledRate = 10 * RATE_PRECISION; // 10 tokens/sec
        PortalPoolImplementation pool = _createPool(scaledRate);

        // Initial credit from pool creation: scaledRate * 86400 / 1000 = 864,000
        // Drain rate = 10 tokens/sec
        // Time to exhaust initial credit = 864,000 / 10 = 86,400 seconds

        // Top up 100 tokens for additional 10 seconds runway
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        // Total credit now = 864,000 + 100 = 864,100
        // Time to exhaust = 864,100 / 10 = 86,410 seconds

        // Advance to exact boundary
        vm.warp(block.timestamp + 86410);

        (int256 balance, uint256 poolDebt,,) = pool.getRewardStatus();
        assertEq(balance, 0, "Balance should be exactly 0");
        assertEq(poolDebt, 0, "Debt should be exactly 0 at boundary");

        // Advance 1 more second
        vm.warp(block.timestamp + 1);

        (, uint256 debtAfter,,) = pool.getRewardStatus();
        assertEq(debtAfter, 10, "Debt should be exactly 10 (1 sec * 10 rate)");
    }

    function test_E2E_Overflow_LargeStakeLargeTime() public {
        // For largeCapacity = 1e24, min rate = 1e24 / 1e12 = 1e12
        uint256 scaledRate = 1e12; // min rate for precision requirements

        poolCount++;
        uint256 largeCapacity = 1e24; // 1M SQD with 18 decimals
        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: largeCapacity,
            peerId: abi.encodePacked("peer-large-", poolCount),
            tokenSuffix: "LARGE",
            distributionRatePerSecond: scaledRate,
            metadata: "",
            rewardToken: address(usdc)
        });

        uint256 initialDeposit = scaledRate * 1 days / RATE_PRECISION;
        usdc.approve(address(factory), initialDeposit);
        address portalAddress = factory.createPortalPool(params);
        PortalPoolImplementation pool = PortalPoolImplementation(portalAddress);

        sqd.mint(alice, largeCapacity);
        vm.startPrank(alice);
        sqd.approve(portalAddress, largeCapacity);
        pool.deposit(largeCapacity);
        vm.stopPrank();

        usdc.mint(operator, 1e15);
        vm.startPrank(operator);
        usdc.approve(address(pool), 1e15);
        pool.topUpRewards(1e15);
        vm.stopPrank();

        // Warp 1 year
        vm.warp(block.timestamp + 365 days);

        // Should not overflow
        uint256 claimable = pool.getClaimableRewards(alice);
        assertTrue(claimable > 0, "Claimable should be > 0");

        // Verify runway calculation doesn't overflow
        int256 runway = pool.getRunway();
        assertTrue(runway != 0, "Runway calculation should work");
    }

    function test_E2E_ZeroRate_EnableDisable() public {
        // Create pool with zero rate
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-zero-", poolCount),
            tokenSuffix: "ZERO",
            distributionRatePerSecond: 0,
            metadata: "",
            rewardToken: address(usdc)
        });

        address portalAddress = factory.createPortalPool(params);
        PortalPoolImplementation pool = PortalPoolImplementation(portalAddress);

        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY);
        pool.deposit(CAPACITY);
        vm.stopPrank();

        // Verify zero rate state
        assertEq(pool.getTotalDrainRate(), 0, "Drain rate is 0");
        assertEq(pool.perStakeRateWad(), 0, "perStakeRateWad is 0");

        // Enable rate
        vm.prank(operator);
        pool.setDistributionRate(100 * RATE_PRECISION);

        assertEq(pool.totalDistributionRatePerSec(), 100 * RATE_PRECISION, "Rate set correctly");
        assertTrue(pool.perStakeRateWad() > 0, "perStakeRateWad > 0 after enabling");

        // Top up and verify rewards work
        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000);
        pool.topUpRewards(10_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 10);

        uint256 claimable = pool.getClaimableRewards(alice);
        assertEq(claimable, 1000, "Rewards work after enabling rate");
    }
}
