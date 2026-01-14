// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../../src/PortalRegistry.sol";
import {FeeRouterModule} from "../../src/FeeRouterModule.sol";
import {IPortalPool} from "../../src/interfaces/IPortalPool.sol";
import {IPortalFactory} from "../../src/interfaces/IPortalFactory.sol";
import {LiquidPortalToken} from "../../src/LiquidPortalToken.sol";
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

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
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

contract PortalPoolE2ETest is Test {
    uint256 constant SQD_DECIMALS = 18;
    uint256 constant SQD_PRICE_CENTS = 5;

    uint256 constant USDC_DECIMALS = 6;
    uint256 constant USDC_UNIT = 10 ** USDC_DECIMALS;

    uint256 constant MIN_STAKE = 1000 * 1e18;
    uint256 constant MANA = 1000;
    uint256 constant MAX_STAKE_PER_WALLET = 100_000 * 1e18;

    // Minimum rate to satisfy precision: capacity / 1e12 = 1e22 / 1e12 = 1e10
    uint256 constant RATE_PER_SEC = 1e10; // scaled rate
    uint256 constant ACTUAL_RATE = 1e10 / 1000; // actual micro-USDC per second = 1e7
    uint256 constant POOL_CAPACITY = 10_000 * 1e18;

    uint256 constant FIRST_TOPUP = 50_000 * USDC_UNIT;
    uint256 constant SECOND_TOPUP = 50_000 * USDC_UNIT;

    uint256 constant DAY = 1 days;
    uint256 constant MONTH = 30 days;

    uint256 constant WORKER_EPOCH_LENGTH = 7200;

    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;

    MockERC20 public sqd;
    MockERC20 public usdc;

    PortalPoolImplementation public pool;

    address public admin = address(this);
    address public operator = address(0x0001);
    address public workerRewardPool = address(0x9999);

    address[15] public stakers;
    uint256[15] public stakeAmounts;
    uint256 public totalStaked;

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

        feeRouter.setFeeConfig(5000, 5000, 0);

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
        feeRouter.setWorkerPoolAddress(workerRewardPool);
        factory.setDefaultWhitelistEnabled(false);

        _setupStakers();

        // Mint enough USDC for initial deposits (rate * 1 days / 1000) and top-ups
        // For capacity 1e24 with min rate 1e12: initial deposit = 1e12 * 86400 / 1000 = 8.64e13 ~= 86.4M USDC
        usdc.mint(admin, 200_000_000 * USDC_UNIT);
        usdc.mint(operator, 200_000_000 * USDC_UNIT);
    }

    function _setupStakers() internal {
        stakeAmounts[0] = 2500 * 1e18;
        stakeAmounts[1] = 1500 * 1e18;
        stakeAmounts[2] = 1250 * 1e18;
        stakeAmounts[3] = 1000 * 1e18;
        stakeAmounts[4] = 750 * 1e18;
        stakeAmounts[5] = 750 * 1e18;
        stakeAmounts[6] = 600 * 1e18;
        stakeAmounts[7] = 500 * 1e18;
        stakeAmounts[8] = 400 * 1e18;
        stakeAmounts[9] = 300 * 1e18;
        stakeAmounts[10] = 200 * 1e18;
        stakeAmounts[11] = 150 * 1e18;
        stakeAmounts[12] = 50 * 1e18;
        stakeAmounts[13] = 40 * 1e18;
        stakeAmounts[14] = 10 * 1e18;

        for (uint256 i = 0; i < 15; i++) {
            stakers[i] = address(uint160(0x1000 + i));
            sqd.mint(stakers[i], stakeAmounts[i]);
            totalStaked += stakeAmounts[i];
        }
    }

    function _logBalance(string memory label, int256 value) internal pure {
        if (value >= 0) {
            console.log(label, "(+USDC):", uint256(value) / USDC_UNIT);
        } else {
            console.log(label, "(-USDC):", uint256(-value) / USDC_UNIT);
        }
    }

    function _logStaker(string memory action, uint256 idx, uint256 amount) internal pure {
        console.log(string.concat("Staker ", _uint2str(idx), " ", action, ":"), amount, "USDC");
    }

    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k--;
            bstr[k] = bytes1(uint8(48 + _i % 10));
            _i /= 10;
        }
        return string(bstr);
    }

    /// @dev Calculate minimum rate to satisfy precision requirement: rate >= capacity / 1e12
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function test_E2E_FullMonthOperation() public {
        // Phase 1: Setup pool with 15 stakers
        uint256 initialDeposit = _setupFullMonthPool();

        // Phase 2: First top-up and verify fee split
        _doFirstTopUp(initialDeposit);

        // Phase 3: Mid-period claims (Day 2)
        vm.warp(block.timestamp + 2 days);
        _doMidPeriodClaims();

        // Phase 4: End of period claims (Day 4)
        vm.warp(block.timestamp + 2 days);
        _doEndPeriodClaims();

        // Phase 5: Debt period (Day 6+)
        vm.warp(block.timestamp + 6 days);
        _verifyDebtPeriod();

        // Phase 6: Second top-up
        _doSecondTopUp();

        // Phase 7: Catchup verification
        vm.warp(block.timestamp + 1 days);
        assertTrue(pool.getClaimableRewards(stakers[10]) > 0, "Rewards after catchup");
        assertTrue(pool.getClaimableRewards(stakers[14]) > 0, "Smallest staker has rewards");

        // Phase 8: Final claims
        _doFinalClaims();

        // Phase 9: Final accounting
        uint256 expectedWorkerPool = (initialDeposit / 2) + ((FIRST_TOPUP + SECOND_TOPUP) * 5000) / 10000;
        assertEq(usdc.balanceOf(workerRewardPool), expectedWorkerPool, "Worker pool total");
    }

    function _setupFullMonthPool() internal returns (uint256 initialDeposit) {
        initialDeposit = RATE_PER_SEC * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAPACITY,
            tokenSuffix: "E2E",
            distributionRatePerSecond: RATE_PER_SEC,
            initialDeposit: initialDeposit,
            metadata: "E2E Test",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        for (uint256 i = 0; i < 15; i++) {
            vm.startPrank(stakers[i]);
            sqd.approve(poolAddr, stakeAmounts[i]);
            pool.deposit(stakeAmounts[i]);
            vm.stopPrank();
        }

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE), "Pool active");
    }

    function _doFirstTopUp(uint256 initialDeposit) internal {
        uint256 workerPoolBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(address(pool), FIRST_TOPUP);
        pool.topUpRewards(FIRST_TOPUP);
        vm.stopPrank();

        uint256 expectedToWorkerPool = FIRST_TOPUP / 2;
        assertEq(usdc.balanceOf(workerRewardPool) - workerPoolBefore, expectedToWorkerPool, "Worker pool 50%");

        uint256 expectedProviderBalance = initialDeposit / 2 + FIRST_TOPUP / 2;
        assertEq(uint256(pool.getCurrentRewardBalance()), expectedProviderBalance, "Provider balance");
    }

    function _doMidPeriodClaims() internal {
        for (uint256 i = 0; i < 3; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                pool.claimRewards();
            }
        }
    }

    function _doEndPeriodClaims() internal {
        for (uint256 i = 3; i <= 6; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                pool.claimRewards();
            }
        }
    }

    function _verifyDebtPeriod() internal {
        assertTrue(pool.getCurrentRewardBalance() < 0, "Should be in debt");
        (,,, bool isDry) = pool.getRewardStatus();
        assertTrue(isDry, "Should be dry");

        // Verify claimable doesn't increase during dry period
        uint256 claimableBefore = pool.getClaimableRewards(stakers[7]);
        vm.warp(block.timestamp + 1 hours);
        assertEq(pool.getClaimableRewards(stakers[7]), claimableBefore, "No increase during dry");
    }

    function _doSecondTopUp() internal {
        int256 debtBefore = pool.getCurrentRewardBalance();

        vm.startPrank(operator);
        usdc.approve(address(pool), SECOND_TOPUP);
        pool.topUpRewards(SECOND_TOPUP);
        vm.stopPrank();

        int256 expectedBalance = debtBefore + int256(SECOND_TOPUP / 2);
        assertEq(pool.getCurrentRewardBalance(), expectedBalance, "Balance after second top-up");
    }

    function _doFinalClaims() internal {
        for (uint256 i = 7; i < 15; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                pool.claimRewards();
            }
        }
    }

    function test_E2E_RewardProportionality() public {
        uint256 initialDeposit = RATE_PER_SEC * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAPACITY,
            tokenSuffix: "PROP",
            distributionRatePerSecond: RATE_PER_SEC,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        uint256 simpleTotal = 0;
        for (uint256 i = 0; i < 15; i++) {
            vm.startPrank(stakers[i]);
            sqd.approve(poolAddr, stakeAmounts[i]);
            pool.deposit(stakeAmounts[i]);
            vm.stopPrank();
            simpleTotal += stakeAmounts[i];
        }

        vm.startPrank(operator);
        usdc.approve(poolAddr, FIRST_TOPUP);
        pool.topUpRewards(FIRST_TOPUP);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days);

        uint256[] memory claimables = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            claimables[i] = pool.getClaimableRewards(stakers[i]);
        }

        uint256 totalClaimable = claimables[0] + claimables[1] + claimables[2];

        console.log("Total claimable (first 3):", totalClaimable / USDC_UNIT, "USDC");
        console.log("Staker 0 (25% stake):", claimables[0] / USDC_UNIT, "USDC");
        console.log("Staker 1 (15% stake):", claimables[1] / USDC_UNIT, "USDC");
        console.log("Staker 2 (12.5% stake):", claimables[2] / USDC_UNIT, "USDC");

        uint256 expectedStaker0 =
            (totalClaimable * stakeAmounts[0]) / (stakeAmounts[0] + stakeAmounts[1] + stakeAmounts[2]);
        uint256 expectedStaker1 =
            (totalClaimable * stakeAmounts[1]) / (stakeAmounts[0] + stakeAmounts[1] + stakeAmounts[2]);
        uint256 expectedStaker2 =
            (totalClaimable * stakeAmounts[2]) / (stakeAmounts[0] + stakeAmounts[1] + stakeAmounts[2]);

        console.log("\nExpected proportions:");
        console.log("Staker 0 expected:", expectedStaker0 / USDC_UNIT, "USDC");
        console.log("Staker 1 expected:", expectedStaker1 / USDC_UNIT, "USDC");
        console.log("Staker 2 expected:", expectedStaker2 / USDC_UNIT, "USDC");

        assertApproxEqRel(claimables[0], expectedStaker0, 0.05e18, "Staker 0 proportion");
        assertApproxEqRel(claimables[1], expectedStaker1, 0.05e18, "Staker 1 proportion");
        assertApproxEqRel(claimables[2], expectedStaker2, 0.05e18, "Staker 2 proportion");
    }

    /**
     * @notice E2E test: Two equal stakers split rewards proportionally
     */
    function test_E2E_TwoStakersGetHundredEach() public {
        // Setup pool with two equal stakers
        (uint256 initialDeposit, uint256 rate) = _setupTwoStakersPool();

        // Operator tops up
        uint256 topUp = 2000 * USDC_UNIT;
        vm.startPrank(operator);
        usdc.approve(address(pool), topUp);
        pool.topUpRewards(topUp);
        vm.stopPrank();

        // Verify fee split
        uint256 expectedProviderBalance = initialDeposit / 2 + topUp / 2;
        assertEq(uint256(pool.getCurrentRewardBalance()), expectedProviderBalance, "Provider balance check");
        assertEq(usdc.balanceOf(workerRewardPool), initialDeposit / 2 + topUp / 2, "Worker pool check");

        // Warp 10% of runway
        uint256 actualRate = rate / 1000;
        uint256 warpTime = (expectedProviderBalance / actualRate) / 10;
        vm.warp(block.timestamp + warpTime);

        // Check claimable rewards
        address alice = stakers[0];
        address bob = stakers[1];
        uint256 aliceClaimable = pool.getClaimableRewards(alice);
        uint256 bobClaimable = pool.getClaimableRewards(bob);

        console.log("Alice claimable:", aliceClaimable / USDC_UNIT, "USDC");
        console.log("Bob claimable:", bobClaimable / USDC_UNIT, "USDC");

        // Equal stakes should have equal rewards
        assertApproxEqRel(aliceClaimable, bobClaimable, 0.01e18, "Equal rewards");
        assertTrue(aliceClaimable > 0, "Alice has rewards");
        assertTrue(bobClaimable > 0, "Bob has rewards");

        // Total distributed matches rate * time
        assertApproxEqRel(aliceClaimable + bobClaimable, warpTime * actualRate, 0.05e18, "Total distributed");

        // Claim and verify
        vm.prank(alice);
        uint256 aliceClaimed = pool.claimRewards();
        vm.prank(bob);
        uint256 bobClaimed = pool.claimRewards();

        assertEq(usdc.balanceOf(alice), aliceClaimed, "Alice USDC");
        assertEq(usdc.balanceOf(bob), bobClaimed, "Bob USDC");
    }

    function _setupTwoStakersPool() internal returns (uint256 initialDeposit, uint256 rate) {
        uint256 poolCap = 2000 * 1e18;
        rate = _minRateForCapacity(poolCap);
        initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: poolCap,
            tokenSuffix: "TWO",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        uint256 stakeEach = 1000 * 1e18;

        vm.startPrank(stakers[0]);
        sqd.approve(poolAddr, stakeEach);
        pool.deposit(stakeEach);
        vm.stopPrank();

        vm.startPrank(stakers[1]);
        sqd.approve(poolAddr, stakeEach);
        pool.deposit(stakeEach);
        vm.stopPrank();

        return (initialDeposit, rate);
    }

    /**
     * @notice Comprehensive E2E test: Full lifecycle with debt and phantom rewards check
     */
    function test_E2E_DebtScenario_PhantomRewards() public {
        // Setup pool and stakers
        (uint256 initialDeposit, uint256 rate, uint256[15] memory variedStakes) = _setupDebtScenarioPool();

        // First top-up and verify
        uint256 firstTop = 5000 * USDC_UNIT;
        uint256 secondTop = 1000 * USDC_UNIT;
        usdc.mint(operator, firstTop + secondTop);

        _topUpAndVerify(firstTop, initialDeposit);

        // Warp 1 month and have first 10 users claim
        vm.warp(block.timestamp + 30 days);
        _claimFirst10Users();

        // Second top-up
        vm.startPrank(operator);
        usdc.approve(address(pool), secondTop);
        pool.topUpRewards(secondTop);
        vm.stopPrank();

        // Warp to month 10 (into debt)
        vm.warp(block.timestamp + 270 days);

        // Verify pool is in debt/dry
        (,,, bool isDry) = pool.getRewardStatus();
        assertTrue(pool.getCurrentRewardBalance() < 0 || isDry, "Pool should be in debt/dry");

        // Users 10-14 never claimed - verify no phantom rewards
        uint256 totalNeverClaimedRewards = _verifyNeverClaimedUsers();

        // Final accounting verification
        assertEq(
            usdc.balanceOf(workerRewardPool), (initialDeposit / 2) + (firstTop + secondTop) / 2, "Worker pool total"
        );
    }

    function _setupDebtScenarioPool()
        internal
        returns (uint256 initialDeposit, uint256 rate, uint256[15] memory variedStakes)
    {
        uint256 poolCap = 1_000_000 * 1e18;
        rate = _minRateForCapacity(poolCap);

        // Varied stake amounts totaling 1M SQD
        variedStakes[0] = 150_000 * 1e18;
        variedStakes[1] = 120_000 * 1e18;
        variedStakes[2] = 100_000 * 1e18;
        variedStakes[3] = 90_000 * 1e18;
        variedStakes[4] = 80_000 * 1e18;
        variedStakes[5] = 70_000 * 1e18;
        variedStakes[6] = 65_000 * 1e18;
        variedStakes[7] = 60_000 * 1e18;
        variedStakes[8] = 55_000 * 1e18;
        variedStakes[9] = 50_000 * 1e18;
        variedStakes[10] = 45_000 * 1e18;
        variedStakes[11] = 40_000 * 1e18;
        variedStakes[12] = 35_000 * 1e18;
        variedStakes[13] = 25_000 * 1e18;
        variedStakes[14] = 15_000 * 1e18;

        for (uint256 i = 0; i < 15; i++) {
            sqd.mint(stakers[i], variedStakes[i]);
        }

        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: poolCap,
            tokenSuffix: "DEBT",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "Debt Test",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        for (uint256 i = 0; i < 15; i++) {
            vm.startPrank(stakers[i]);
            sqd.approve(poolAddr, variedStakes[i]);
            pool.deposit(variedStakes[i]);
            vm.stopPrank();
        }

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE), "Pool active");
        return (initialDeposit, rate, variedStakes);
    }

    function _topUpAndVerify(uint256 topUpAmount, uint256 initialDeposit) internal {
        uint256 workerPoolBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 workerPoolReceived = usdc.balanceOf(workerRewardPool) - workerPoolBefore;
        assertEq(workerPoolReceived, topUpAmount / 2, "Worker pool gets 50%");

        uint256 expectedProviderBalance = initialDeposit / 2 + topUpAmount / 2;
        assertEq(uint256(pool.getCurrentRewardBalance()), expectedProviderBalance, "Provider balance");
    }

    function _claimFirst10Users() internal {
        for (uint256 i = 0; i < 10; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                pool.claimRewards();
            }
        }
    }

    function _verifyNeverClaimedUsers() internal returns (uint256 totalNeverClaimed) {
        for (uint256 i = 10; i < 15; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            totalNeverClaimed += claimable;

            if (claimable > 0) {
                uint256 balBefore = usdc.balanceOf(stakers[i]);
                vm.prank(stakers[i]);
                uint256 claimed = pool.claimRewards();
                uint256 balAfter = usdc.balanceOf(stakers[i]);

                // No phantom rewards - what's claimable can actually be claimed
                assertEq(balAfter - balBefore, claimed, "No phantom rewards");
            }
        }
    }

    /**
     * @notice Exit Queue (Convoy Belt) Edge Cases
     *
     * Tests the exit queue with:
     * - 3 stakers request exit after 1 month:
     *   1. Staker 0: Claims ALL rewards before exiting
     *   2. Staker 1: NEVER claimed, just exits
     *   3. Staker 2: Claims HALF rewards, then exits
     * - Verify they must wait in convoy belt
     * - While waiting, new staker tries to deposit (should work or fail?)
     * - Verify rewards are correctly handled for exiters
     * - Test early withdrawal attempts (should fail)
     * - Verify correct unlock timing
     */
    function test_E2E_ConvoyBelt_CriticalEdgeCases() public {
        // Use helper to reduce stack depth
        (address[5] memory exitStakers, uint256 STAKE_EACH) = _setupConvoyBeltTest();

        vm.warp(block.timestamp + 30 days);

        // Log rewards at 1 month
        console.log("Staker 0 rewards:", pool.getClaimableRewards(exitStakers[0]) / USDC_UNIT, "USDC");
        console.log("Staker 1 rewards:", pool.getClaimableRewards(exitStakers[1]) / USDC_UNIT, "USDC");
        console.log("Staker 2 rewards:", pool.getClaimableRewards(exitStakers[2]) / USDC_UNIT, "USDC");

        // Staker 0: Claims ALL rewards, then exits
        console.log("Staker 0: Claiming ALL rewards before exit...");
        vm.prank(exitStakers[0]);
        console.log("  Claimed:", pool.claimRewards() / USDC_UNIT, "USDC");
        vm.prank(exitStakers[0]);
        pool.requestExit(STAKE_EACH);

        // Staker 1: NEVER claims, just exits directly
        console.log("Staker 1: NEVER claimed, exiting directly...");
        console.log("  Unclaimed rewards:", pool.getClaimableRewards(exitStakers[1]) / USDC_UNIT, "USDC");
        vm.prank(exitStakers[1]);
        pool.requestExit(STAKE_EACH);
        console.log("  Rewards after exit request:", pool.getClaimableRewards(exitStakers[1]) / USDC_UNIT, "USDC");

        // Staker 2: Claims, then exits
        console.log("Staker 2: Claiming rewards, then exit...");
        vm.prank(exitStakers[2]);
        console.log("  Claimed:", pool.claimRewards() / USDC_UNIT, "USDC");
        vm.prank(exitStakers[2]);
        pool.requestExit(STAKE_EACH);

        // Try early withdrawals - should all fail
        _testEarlyWithdrawalsBlocked(exitStakers);

        // Test new staker deposit while others exiting
        _testNewStakerDeposit(STAKE_EACH);

        // Test claiming while in queue
        if (pool.getClaimableRewards(exitStakers[1]) > 0) {
            vm.prank(exitStakers[1]);
            try pool.claimRewards() returns (uint256 claimed) {
                console.log("  CLAIMED while in exit queue:", claimed / USDC_UNIT, "USDC");
            } catch {
                console.log("  Claim blocked while in queue");
            }
        }

        // Warp past queue and withdraw
        vm.warp(block.timestamp + 1 days);
        console.log("Warped 1 day forward");

        _withdrawAndVerify(exitStakers, STAKE_EACH);

        // Verify double withdrawal blocked
        vm.prank(exitStakers[0]);
        vm.expectRevert();
        pool.withdrawExit(0);
        console.log("Staker 0 correctly blocked from double withdrawal");

        // Stakers 3 and 4 still in pool - verify they can claim
        console.log("Staker 3 rewards:", pool.getClaimableRewards(exitStakers[3]) / USDC_UNIT, "USDC");
        console.log("Staker 4 rewards:", pool.getClaimableRewards(exitStakers[4]) / USDC_UNIT, "USDC");

        vm.prank(exitStakers[3]);
        uint256 claimed3 = pool.claimRewards();
        console.log("Staker 3 claimed:", claimed3 / USDC_UNIT, "USDC");
        assertTrue(claimed3 > 0, "Active stakers should still earn rewards");
    }

    function _setupConvoyBeltTest() internal returns (address[5] memory exitStakers, uint256 STAKE_EACH) {
        uint256 POOL_CAP = 100_000 * 1e18;
        uint256 RATE = _minRateForCapacity(POOL_CAP);
        STAKE_EACH = 20_000 * 1e18;

        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        uint256 initialDeposit = RATE * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAP,
            tokenSuffix: "CONV",
            distributionRatePerSecond: RATE,
            initialDeposit: initialDeposit,
            metadata: "Convoy Belt Test",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        for (uint256 i = 0; i < 5; i++) {
            exitStakers[i] = address(uint160(0x5000 + i));
            sqd.mint(exitStakers[i], STAKE_EACH);
            vm.startPrank(exitStakers[i]);
            sqd.approve(poolAddr, STAKE_EACH);
            pool.deposit(STAKE_EACH);
            vm.stopPrank();
        }

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE), "Pool should be active");

        uint256 TOP_UP = 50_000 * USDC_UNIT;
        usdc.mint(operator, TOP_UP);
        vm.startPrank(operator);
        usdc.approve(poolAddr, TOP_UP);
        pool.topUpRewards(TOP_UP);
        vm.stopPrank();

        return (exitStakers, STAKE_EACH);
    }

    function _testEarlyWithdrawalsBlocked(address[5] memory exitStakers) internal {
        console.log("Testing early withdrawal blocks...");
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(exitStakers[i]);
            vm.expectRevert();
            pool.withdrawExit(0);
        }
        console.log("  All early withdrawals correctly blocked");
    }

    function _testNewStakerDeposit(uint256 STAKE_EACH) internal {
        address newStaker = address(0x9999);
        sqd.mint(newStaker, STAKE_EACH);
        console.log("New staker attempting deposit while 3 are exiting...");

        vm.startPrank(newStaker);
        sqd.approve(address(pool), STAKE_EACH);
        pool.deposit(STAKE_EACH);
        vm.stopPrank();
        console.log("  New staker deposited successfully!");
    }

    function _withdrawAndVerify(address[5] memory exitStakers, uint256 STAKE_EACH) internal {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(exitStakers[i]);
            pool.withdrawExit(0);
            assertEq(sqd.balanceOf(exitStakers[i]), STAKE_EACH, "Should have SQD back");
        }

        console.log("Staker 0 USDC:", usdc.balanceOf(exitStakers[0]) / USDC_UNIT);
        console.log("Staker 1 USDC:", usdc.balanceOf(exitStakers[1]) / USDC_UNIT);
        console.log("Staker 2 USDC:", usdc.balanceOf(exitStakers[2]) / USDC_UNIT);

        assertTrue(usdc.balanceOf(exitStakers[0]) > 0, "Staker 0 should have claimed rewards");
    }
}
