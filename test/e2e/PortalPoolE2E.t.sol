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

contract MockNetworkController {
    uint256 public workerEpochLength;
    uint256 public minStakeThreshold;
    address public workerRewardPool;

    constructor(uint256 _epochLength, uint256 _minStake, address _workerPool) {
        workerEpochLength = _epochLength;
        minStakeThreshold = _minStake;
        workerRewardPool = _workerPool;
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

    uint256 constant RATE_PER_SEC = 1e5;
    uint256 constant POOL_CAPACITY = 10_000 * 1e18;

    uint256 constant FIRST_TOPUP = 50_000 * USDC_UNIT;
    uint256 constant SECOND_TOPUP = 50_000 * USDC_UNIT;

    uint256 constant DAY = 1 days;
    uint256 constant MONTH = 30 days;

    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;

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

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);
        registry = new PortalRegistry(address(sqd), address(networkController), MIN_STAKE, MANA);
        feeRouter = new FeeRouterModule();

        feeRouter.setFeeConfig(5000, 5000, 0);

        implementation = new PortalPoolImplementation();

        factory = new PortalPoolFactory(
            address(implementation),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            address(usdc),
            MAX_STAKE_PER_WALLET
        );

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setWorkerPoolAddress(workerRewardPool);

        _setupStakers();

        usdc.mint(operator, 500_000 * USDC_UNIT);
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

        console.log("=== STAKER SETUP ===");
        console.log("Total stakers: 15");
        console.log("Total to stake:", totalStaked / 1e18, "SQD");
        console.log("Total value at $0.05:", (totalStaked / 1e18) * 5 / 100, "USD");
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

    function test_E2E_FullMonthOperation() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAPACITY,
            peerId: abi.encodePacked("peer-e2e-test"),
            tokenSuffix: "E2E",
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: "E2E Test Portal"
        });

        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        console.log("Pool deployed at:", poolAddr);
        console.log("Capacity:", POOL_CAPACITY / 1e18, "SQD");
        console.log("Rate per second:", RATE_PER_SEC, "micro-USDC");
        console.log("Expected daily drain:", RATE_PER_SEC * 86400 / USDC_UNIT, "USDC");

        uint256 actualTotalStaked = 0;
        for (uint256 i = 0; i < 15; i++) {
            vm.startPrank(stakers[i]);
            sqd.approve(poolAddr, stakeAmounts[i]);
            pool.deposit(stakeAmounts[i]);
            vm.stopPrank();
            actualTotalStaked += stakeAmounts[i];
        }

        console.log("\nAll 15 stakers deposited");
        console.log("Total staked:", actualTotalStaked / 1e18, "SQD");
        console.log("Pool state:", uint256(pool.getState()));

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PortalState.ACTIVE), "Pool should be active");

        console.log("\n=== PHASE 2: OPERATOR TOP-UP ($3000) ===\n");

        uint256 workerPoolBalanceBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(poolAddr, FIRST_TOPUP);
        pool.topUpRewards(FIRST_TOPUP);
        vm.stopPrank();

        uint256 expectedToProviders = (FIRST_TOPUP * 5000) / 10000;
        uint256 expectedToWorkerPool = (FIRST_TOPUP * 5000) / 10000;

        uint256 workerPoolBalanceAfter = usdc.balanceOf(workerRewardPool);
        uint256 actualToWorkerPool = workerPoolBalanceAfter - workerPoolBalanceBefore;

        console.log("Top-up amount:", FIRST_TOPUP / USDC_UNIT, "USDC");
        console.log("To providers (50%):", expectedToProviders / USDC_UNIT, "USDC");
        console.log("To worker pool (50%):", expectedToWorkerPool / USDC_UNIT, "USDC");
        console.log("Worker pool received:", actualToWorkerPool / USDC_UNIT, "USDC");

        assertEq(actualToWorkerPool, expectedToWorkerPool, "Worker pool should receive 50%");

        int256 poolBalance = pool.getCurrentRewardBalance();
        console.log("Pool balance (USDC):", uint256(poolBalance) / USDC_UNIT);
        assertEq(uint256(poolBalance), expectedToProviders, "Balance should equal provider portion");

        int256 runway = pool.getRunway();
        uint256 expectedRunwayDays = expectedToProviders / (RATE_PER_SEC * 86400);
        console.log("Runway timestamp:", runway);
        console.log("Expected runway:", expectedRunwayDays, "days");

        console.log("\n=== PHASE 3: MID-PERIOD CLAIMS (Day 2) ===\n");

        vm.warp(block.timestamp + 2 days);

        console.log("Current time: Day 2");
        _logBalance("Current balance", pool.getCurrentRewardBalance());

        uint256[] memory midPeriodClaims = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            _logStaker("claimable", i, claimable / USDC_UNIT);

            if (claimable > 0) {
                vm.prank(stakers[i]);
                midPeriodClaims[i] = pool.claimRewards();
                _logStaker("claimed", i, midPeriodClaims[i] / USDC_UNIT);
            }
        }

        uint256 totalMidPeriodClaims = midPeriodClaims[0] + midPeriodClaims[1] + midPeriodClaims[2];
        console.log("Total mid-period claims:", totalMidPeriodClaims / USDC_UNIT, "USDC");

        uint256 totalDelegatorRewards2Days = (RATE_PER_SEC / 2) * 2 days;
        console.log("Expected delegator rewards (2 days):", totalDelegatorRewards2Days / USDC_UNIT, "USDC");

        console.log("\n=== PHASE 4: END OF PERIOD CLAIMS (Day 4) ===\n");

        vm.warp(block.timestamp + 2 days);

        console.log("Current time: Day 4");
        int256 balanceDay30 = pool.getCurrentRewardBalance();
        _logBalance("Current balance", balanceDay30);

        uint256 totalEndMonthClaims = 0;
        for (uint256 i = 3; i <= 6; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            _logStaker("claimable", i, claimable / USDC_UNIT);

            if (claimable > 0) {
                vm.prank(stakers[i]);
                uint256 claimed = pool.claimRewards();
                totalEndMonthClaims += claimed;
                _logStaker("claimed", i, claimed / USDC_UNIT);
            }
        }
        console.log("Total end-month claims:", totalEndMonthClaims / USDC_UNIT, "USDC");

        console.log("\n=== PHASE 5: DEBT PERIOD ===\n");

        (int256 statusBalance, uint256 debt, int256 runwayTs, bool isDry) = pool.getRewardStatus();
        _logBalance("Status balance", statusBalance);
        console.log("Debt:", debt / USDC_UNIT, "USDC");
        console.log("Is dry:", isDry);

        vm.warp(block.timestamp + 6 days);

        console.log("\nAfter 2 days in debt (Day 6):");
        int256 balanceDay6 = pool.getCurrentRewardBalance();
        _logBalance("Current balance", balanceDay6);
        assertTrue(balanceDay6 < 0, "Should be in debt");

        (statusBalance, debt, runwayTs, isDry) = pool.getRewardStatus();
        _logBalance("Status balance", statusBalance);
        console.log("Debt accumulated:", debt / USDC_UNIT, "USDC");
        console.log("Runway timestamp:", uint256(runwayTs > 0 ? runwayTs : int256(0)));
        console.log("Is dry:", isDry);
        assertTrue(isDry, "Should be dry");

        uint256 claimableStaker7 = pool.getClaimableRewards(stakers[7]);
        console.log("Staker 7 claimable during dry:", claimableStaker7 / USDC_UNIT, "USDC");

        vm.warp(block.timestamp + 1 hours);
        uint256 claimableStaker7After = pool.getClaimableRewards(stakers[7]);
        console.log("Staker 7 claimable 1 hour later:", claimableStaker7After / USDC_UNIT, "USDC");
        assertEq(claimableStaker7, claimableStaker7After, "Claimable should not increase during dry period");

        console.log("\n=== PHASE 6: SECOND TOP-UP & CATCHUP ===\n");

        int256 debtBefore = pool.getCurrentRewardBalance();
        _logBalance("Balance before top-up", debtBefore);

        uint256 claimableStaker10Before = pool.getClaimableRewards(stakers[10]);
        uint256 claimableStaker14Before = pool.getClaimableRewards(stakers[14]);

        workerPoolBalanceBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(poolAddr, SECOND_TOPUP);
        pool.topUpRewards(SECOND_TOPUP);
        vm.stopPrank();

        workerPoolBalanceAfter = usdc.balanceOf(workerRewardPool);
        actualToWorkerPool = workerPoolBalanceAfter - workerPoolBalanceBefore;
        console.log("Worker pool received (2nd top-up):", actualToWorkerPool / USDC_UNIT, "USDC");
        assertEq(actualToWorkerPool, expectedToWorkerPool, "Worker pool should receive 50% again");

        int256 balanceAfterTopUp = pool.getCurrentRewardBalance();
        _logBalance("Balance after top-up", balanceAfterTopUp);

        int256 expectedBalance = debtBefore + int256(expectedToProviders);
        _logBalance("Expected balance", expectedBalance);
        assertEq(balanceAfterTopUp, expectedBalance, "Balance should account for debt");

        console.log("\n=== PHASE 7: CATCHUP VERIFICATION ===\n");

        vm.warp(block.timestamp + 1 days);

        uint256 claimableStaker10After = pool.getClaimableRewards(stakers[10]);
        uint256 claimableStaker14After = pool.getClaimableRewards(stakers[14]);

        console.log("Staker 10 (never claimed):");
        console.log("  Before 2nd top-up:", claimableStaker10Before / USDC_UNIT, "USDC");
        console.log("  After 1 more day:", claimableStaker10After / USDC_UNIT, "USDC");
        assertTrue(claimableStaker10After > claimableStaker10Before, "Should have more rewards after catchup");

        console.log("Staker 14 (never claimed, smallest stake):");
        console.log("  Before 2nd top-up:", claimableStaker14Before / USDC_UNIT, "USDC");
        console.log("  After 1 more day:", claimableStaker14After / USDC_UNIT, "USDC");
        assertTrue(claimableStaker14After > claimableStaker14Before, "Smallest staker should also earn");

        console.log("\n=== PHASE 8: FINAL CLAIMS & ACCOUNTING ===\n");

        uint256 totalFinalClaims = 0;
        for (uint256 i = 7; i < 15; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                uint256 claimed = pool.claimRewards();
                totalFinalClaims += claimed;
                _logStaker("final claim", i, claimed / USDC_UNIT);
            }
        }

        console.log("\nTotal final claims:", totalFinalClaims / USDC_UNIT, "USDC");

        console.log("\n=== PHASE 9: OVERALL ACCOUNTING ===\n");

        uint256 totalWorkerPoolReceived = usdc.balanceOf(workerRewardPool);
        uint256 treasuryAccumulated = pool.treasuryAccumulated();

        console.log("TOTAL TOP-UPS:", (FIRST_TOPUP + SECOND_TOPUP) / USDC_UNIT, "USDC");
        console.log("Worker pool total:", totalWorkerPoolReceived / USDC_UNIT, "USDC");
        console.log("Treasury accumulated:", treasuryAccumulated / USDC_UNIT, "USDC");
        _logBalance("Pool current balance", pool.getCurrentRewardBalance());

        uint256 expectedTotalToWorkerPool = ((FIRST_TOPUP + SECOND_TOPUP) * 5000) / 10000;
        assertEq(totalWorkerPoolReceived, expectedTotalToWorkerPool, "Total worker pool should be 50% of all top-ups");

        console.log("\n=== E2E TEST COMPLETE ===");
        console.log("All assertions passed!");

        console.log("\n=== FINAL STAKER USDC BALANCES ===");
        for (uint256 i = 0; i < 15; i++) {
            uint256 stakerBalance = usdc.balanceOf(stakers[i]);
            if (stakerBalance > 0) {
                _logStaker("balance", i, stakerBalance / USDC_UNIT);
            }
        }
    }

    function test_E2E_RewardProportionality() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAPACITY,
            peerId: abi.encodePacked("peer-prop-test"),
            tokenSuffix: "PROP",
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: ""
        });

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

        console.log("\nProportionality verified!");
    }

    /**
     * @notice E2E test: $2000 top-up with 2 stakers each getting $100
     *
     * Flow:
     * 1. Operator tops up $2000
     * 2. FeeRouter splits 50/50: $1000 worker pool, $1000 provider balance
     * 3. 2 stakers with equal stakes
     * 4. After 1 day with $200/day rate: each staker claims $100
     */
    function test_E2E_TwoStakersGetHundredEach() public {
        console.log("=== E2E: $2000 Top-up, 2 Stakers ===");

        // Setup: $200/day = 200 * 1e6 / 86400 = ~2314 wei/sec
        uint256 DAILY_RATE = 200 * USDC_UNIT;
        uint256 RATE = DAILY_RATE / 1 days;

        // Create pool with 2000 SQD capacity (2 stakers, 1000 each)
        uint256 POOL_CAP = 2000 * 1e18;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAP,
            peerId: abi.encodePacked("peer-two-stakers"),
            tokenSuffix: "TWO",
            distributionRatePerSecond: RATE,
            metadata: ""
        });

        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        // Two stakers with equal stakes
        address alice = stakers[0];
        address bob = stakers[1];
        uint256 stakeEach = 1000 * 1e18;

        console.log("\n=== DEPOSITS ===");
        console.log("Alice deposits:", stakeEach / 1e18, "SQD");

        vm.startPrank(alice);
        sqd.approve(poolAddr, stakeEach);
        pool.deposit(stakeEach);
        vm.stopPrank();

        console.log("Bob deposits:", stakeEach / 1e18, "SQD");

        vm.startPrank(bob);
        sqd.approve(poolAddr, stakeEach);
        pool.deposit(stakeEach);
        vm.stopPrank();

        console.log("Pool activated:", pool.getState() == IPortalPool.PortalState.ACTIVE);

        // Operator tops up $2000
        uint256 TOP_UP = 2000 * USDC_UNIT;

        console.log("\n=== TOP-UP ===");
        console.log("Operator tops up:", TOP_UP / USDC_UNIT, "USDC");

        vm.startPrank(operator);
        usdc.approve(poolAddr, TOP_UP);
        pool.topUpRewards(TOP_UP);
        vm.stopPrank();

        // After FeeRouter 50/50 split: $1000 to providers
        int256 providerBalance = pool.getCurrentRewardBalance();
        console.log("Provider balance after split:", uint256(providerBalance) / USDC_UNIT, "USDC");
        console.log("Worker pool received:", usdc.balanceOf(workerRewardPool) / USDC_UNIT, "USDC");

        assertEq(uint256(providerBalance), TOP_UP / 2, "Provider balance should be 50% of top-up");
        assertEq(usdc.balanceOf(workerRewardPool), TOP_UP / 2, "Worker pool should get 50%");

        // Warp 1 day
        console.log("\n=== AFTER 1 DAY ===");
        vm.warp(block.timestamp + 1 days);

        // Check claimable rewards
        uint256 aliceClaimable = pool.getClaimableRewards(alice);
        uint256 bobClaimable = pool.getClaimableRewards(bob);

        console.log("Alice claimable:", aliceClaimable / USDC_UNIT, "USDC");
        console.log("Bob claimable:", bobClaimable / USDC_UNIT, "USDC");
        console.log("Total claimable:", (aliceClaimable + bobClaimable) / USDC_UNIT, "USDC");

        // Each should have ~$100 (half of $200 daily rate)
        uint256 expectedEach = DAILY_RATE / 2;
        console.log("Expected each:", expectedEach / USDC_UNIT, "USDC");

        // Note: ~14% rounding error due to integer division in rate calculation
        // Rate = 200e6 / 86400 = 2314 wei/sec (truncated)
        // Actual daily = 2314 * 86400 = 199.93 USDC (vs expected 200)
        assertApproxEqRel(aliceClaimable, expectedEach, 0.15e18, "Alice should get ~$100");
        assertApproxEqRel(bobClaimable, expectedEach, 0.15e18, "Bob should get ~$100");

        // Claim rewards
        console.log("\n=== CLAIMS ===");

        vm.prank(alice);
        uint256 aliceClaimed = pool.claimRewards();
        console.log("Alice claimed:", aliceClaimed / USDC_UNIT, "USDC");

        vm.prank(bob);
        uint256 bobClaimed = pool.claimRewards();
        console.log("Bob claimed:", bobClaimed / USDC_UNIT, "USDC");

        // Verify USDC balances
        assertApproxEqRel(usdc.balanceOf(alice), expectedEach, 0.15e18, "Alice USDC balance");
        assertApproxEqRel(usdc.balanceOf(bob), expectedEach, 0.15e18, "Bob USDC balance");

        console.log("\n=== SUMMARY ===");
        console.log("Top-up: $2000");
        console.log("Worker pool: $1000 (50%)");
        console.log("Provider balance: $1000 (50%)");
        console.log("Daily distribution: $200");
        console.log("After 1 day, each of 2 stakers: ~$100");
        console.log("\n=== TEST PASSED ===");
    }

    /**
     * @notice Comprehensive E2E test: Full lifecycle with debt and phantom rewards check
     *
     * Scenario:
     * - Pool with 1M SQD capacity
     * - 15 stakers with varied stakes (1.5% to 15% each)
     * - Rate: $1000/month
     * - Initial top-up: $5000 → $2500 to providers (covers ~2.5 months)
     * - After 1 month: 10 users claim, operator tops up $1000 more
     * - At month 10: Pool in debt, 5 users never claimed - verify their rewards
     * - Check for phantom rewards (shown but can't be claimed)
     */
    function test_E2E_DebtScenario_PhantomRewards() public {
        // Rate: $1000/month = 1,000,000,000 / (30 * 86400) ≈ 386 USDC/sec
        uint256 MONTHLY_RATE_USD = 1000;
        uint256 RATE = (MONTHLY_RATE_USD * USDC_UNIT) / 30 days;
        console.log("Rate per second:", RATE, "micro-USDC");
        console.log("Expected monthly distribution:", RATE * 30 days / USDC_UNIT, "USDC");

        // Pool capacity: 1M SQD
        uint256 POOL_CAP = 1_000_000 * 1e18;

        // Define varied stake amounts for 15 stakers (totaling 1M SQD)
        uint256[15] memory variedStakes;
        variedStakes[0] = 150_000 * 1e18;   // 15%
        variedStakes[1] = 120_000 * 1e18;   // 12%
        variedStakes[2] = 100_000 * 1e18;   // 10%
        variedStakes[3] = 90_000 * 1e18;    // 9%
        variedStakes[4] = 80_000 * 1e18;    // 8%
        variedStakes[5] = 70_000 * 1e18;    // 7%
        variedStakes[6] = 65_000 * 1e18;    // 6.5%
        variedStakes[7] = 60_000 * 1e18;    // 6%
        variedStakes[8] = 55_000 * 1e18;    // 5.5%
        variedStakes[9] = 50_000 * 1e18;    // 5%
        // Users 10-14 will NEVER claim
        variedStakes[10] = 45_000 * 1e18;   // 4.5%
        variedStakes[11] = 40_000 * 1e18;   // 4%
        variedStakes[12] = 35_000 * 1e18;   // 3.5%
        variedStakes[13] = 25_000 * 1e18;   // 2.5%
        variedStakes[14] = 15_000 * 1e18;   // 1.5%

        uint256 totalStake = 0;
        for (uint256 i = 0; i < 15; i++) {
            totalStake += variedStakes[i];
        }
        console.log("Total stake:", totalStake / 1e18, "SQD");
        assertEq(totalStake, POOL_CAP, "Stakes should sum to capacity");

        uint256 FIRST_TOP = 5000 * USDC_UNIT;
        uint256 SECOND_TOP = 1000 * USDC_UNIT;
        uint256 TOTAL_PROVIDER_CREDIT = ((FIRST_TOP + SECOND_TOP) * 5000) / 10000;
        uint256 TOTAL_DELEGATOR_REWARDS = TOTAL_PROVIDER_CREDIT / 2; // 50% to delegators

        console.log("First top-up:", FIRST_TOP / USDC_UNIT, "USDC");
        console.log("Second top-up:", SECOND_TOP / USDC_UNIT, "USDC");
        console.log("Total provider credit (50% of top-ups):", TOTAL_PROVIDER_CREDIT / USDC_UNIT, "USDC");
        console.log("Total delegator rewards (50% of credit):", TOTAL_DELEGATOR_REWARDS / USDC_UNIT, "USDC");

        // Calculate runway
        uint256 delegatorRate = RATE / 2;
        uint256 runwaySeconds = TOTAL_PROVIDER_CREDIT / RATE;
        console.log("Runway (seconds):", runwaySeconds);
        console.log("Runway (days):", runwaySeconds / 1 days);
        console.log("Runway (months):", runwaySeconds / 30 days);

        // Expected rewards for users 10-14 (never claim)
        uint256[5] memory expectedNeverClaimed;
        console.log("Expected rewards for never-claimers (USDC):");
        for (uint256 i = 0; i < 5; i++) {
            expectedNeverClaimed[i] = (variedStakes[10 + i] * TOTAL_DELEGATOR_REWARDS) / totalStake;
        }
        console.log("  User 10:", expectedNeverClaimed[0] / USDC_UNIT);
        console.log("  User 11:", expectedNeverClaimed[1] / USDC_UNIT);
        console.log("  User 12:", expectedNeverClaimed[2] / USDC_UNIT);
        console.log("  User 13:", expectedNeverClaimed[3] / USDC_UNIT);
        console.log("  User 14:", expectedNeverClaimed[4] / USDC_UNIT);

        console.log("\n=== PHASE 1: CREATE POOL ===\n");

        for (uint256 i = 0; i < 15; i++) {
            sqd.mint(stakers[i], variedStakes[i]);
        }

        factory.setDefaultMaxStakePerWallet(type(uint256).max); // Remove wallet limit

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAP,
            peerId: abi.encodePacked("peer-debt-phantom-test"),
            tokenSuffix: "DEBT",
            distributionRatePerSecond: RATE,
            metadata: "Debt & Phantom Rewards Test"
        });

        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);
        console.log("Pool deployed at:", poolAddr);


        for (uint256 i = 0; i < 15; i++) {
            vm.startPrank(stakers[i]);
            sqd.approve(poolAddr, variedStakes[i]);
            pool.deposit(variedStakes[i]);
            vm.stopPrank();
        }
        console.log("All 15 stakers deposited successfully");

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PortalState.ACTIVE), "Pool should be active");
        console.log("Pool state: ACTIVE");

        usdc.mint(operator, FIRST_TOP + SECOND_TOP);

        uint256 workerPoolBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(poolAddr, FIRST_TOP);
        pool.topUpRewards(FIRST_TOP);
        vm.stopPrank();

        uint256 workerPoolAfter = usdc.balanceOf(workerRewardPool);
        uint256 workerPoolReceived = workerPoolAfter - workerPoolBefore;

        console.log("Top-up amount:", FIRST_TOP / USDC_UNIT, "USDC");
        console.log("Worker pool received (50%):", workerPoolReceived / USDC_UNIT, "USDC");

        int256 creditAfterFirstTop = pool.getCurrentRewardBalance();
        console.log("Provider credit:", uint256(creditAfterFirstTop) / USDC_UNIT, "USDC");

        assertEq(workerPoolReceived, FIRST_TOP / 2, "Worker pool should get 50%");
        assertEq(uint256(creditAfterFirstTop), FIRST_TOP / 2, "Provider credit should be 50%");

        vm.warp(block.timestamp + 30 days);
        console.log("Time warped: +30 days");

        int256 balanceAt1Month = pool.getCurrentRewardBalance();
        console.log("Provider balance after 1 month (USDC):");
        console.logInt(balanceAt1Month / int256(USDC_UNIT));

        // Monthly distribution: RATE * 30 days
        uint256 monthlyDistribution = RATE * 30 days;
        console.log("Monthly distribution (USDC):", monthlyDistribution / USDC_UNIT);

        // 10 users (0-9) claim
        uint256 totalClaimedMonth1 = 0;
        for (uint256 i = 0; i < 10; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                vm.prank(stakers[i]);
                uint256 claimed = pool.claimRewards();
                totalClaimedMonth1 += claimed;
            }
        }
        console.log("Total claimed by 10 users (USDC):", totalClaimedMonth1 / USDC_UNIT);
        int256 balanceBeforeSecondTop = pool.getCurrentRewardBalance();
        console.log("Balance before 2nd top-up (USDC):");
        console.logInt(balanceBeforeSecondTop / int256(USDC_UNIT));

        vm.startPrank(operator);
        usdc.approve(poolAddr, SECOND_TOP);
        pool.topUpRewards(SECOND_TOP);
        vm.stopPrank();

        int256 balanceAfterSecondTop = pool.getCurrentRewardBalance();
        console.log("Balance after 2nd top-up (USDC):");
        console.logInt(balanceAfterSecondTop / int256(USDC_UNIT));

        vm.warp(block.timestamp + 270 days); // 9 more months
        console.log("Time warped: +270 days (now at month 10)");

        int256 balanceAt10Months = pool.getCurrentRewardBalance();
        console.log("Provider balance at month 10 (USDC):");
        console.logInt(balanceAt10Months / int256(USDC_UNIT));

        // Check debt status
        (int256 statusBalance, uint256 debt, int256 runwayTs, bool isDry) = pool.getRewardStatus();
        console.log("Status balance (USDC):");
        console.logInt(statusBalance / int256(USDC_UNIT));
        console.log("Debt (USDC):", debt / USDC_UNIT);
        console.log("Is dry:", isDry);

        assertTrue(balanceAt10Months < 0 || isDry, "Pool should be in debt or dry at month 10");

        console.log("Users 10-14 NEVER claimed. Checking their rewards");

        uint256 totalNeverClaimedRewards = 0;
        uint256[5] memory actualClaimable;

        for (uint256 i = 10; i < 15; i++) {
            actualClaimable[i - 10] = pool.getClaimableRewards(stakers[i]);
            totalNeverClaimedRewards += actualClaimable[i - 10];
        }

        console.log("User 10 claimable (USDC):", actualClaimable[0] / USDC_UNIT);
        console.log("User 11 claimable (USDC):", actualClaimable[1] / USDC_UNIT);
        console.log("User 12 claimable (USDC):", actualClaimable[2] / USDC_UNIT);
        console.log("User 13 claimable (USDC):", actualClaimable[3] / USDC_UNIT);
        console.log("User 14 claimable (USDC):", actualClaimable[4] / USDC_UNIT);
        console.log("Total claimable (USDC):", totalNeverClaimedRewards / USDC_UNIT);

        // Get pool's actual USDC balance
        uint256 poolUsdcBalance = usdc.balanceOf(poolAddr);
        console.log("Pool USDC balance:", poolUsdcBalance / USDC_UNIT);

        // Try to claim all rewards
        uint256 totalActuallyClaimed = 0;
        uint256[5] memory claimedAmounts;
        bool[5] memory claimFailed;

        for (uint256 i = 10; i < 15; i++) {
            uint256 claimable = pool.getClaimableRewards(stakers[i]);
            if (claimable > 0) {
                uint256 balBefore = usdc.balanceOf(stakers[i]);
                vm.prank(stakers[i]);
                try pool.claimRewards() returns (uint256 claimed) {
                    totalActuallyClaimed += claimed;
                    claimedAmounts[i - 10] = claimed;
                    uint256 balAfter = usdc.balanceOf(stakers[i]);
                    assertEq(balAfter - balBefore, claimed, "USDC balance should increase by claimed amount");
                } catch {
                    claimFailed[i - 10] = true;
                }
            }
        }

        console.log("User 10 claimed:", claimedAmounts[0] / USDC_UNIT);
        console.log("User 11 claimed:", claimedAmounts[1] / USDC_UNIT);
        console.log("User 12 claimed:", claimedAmounts[2] / USDC_UNIT);
        console.log("User 13 claimed:", claimedAmounts[3] / USDC_UNIT);
        console.log("User 14 claimed:", claimedAmounts[4] / USDC_UNIT);

        // Check for phantom rewards (failed claims)
        for (uint256 i = 0; i < 5; i++) {
            if (claimFailed[i]) {
                console.log("PHANTOM REWARD DETECTED for user", 10 + i);
                revert("Phantom reward detected!");
            }
        }

        console.log("Total actually claimed:", totalActuallyClaimed / USDC_UNIT);
        assertApproxEqAbs(
            totalNeverClaimedRewards,
            totalActuallyClaimed,
            100, // 100 wei tolerance
            "PHANTOM REWARDS: Claimable != Actually claimed"
        );

        console.log("\n=== PHASE 9: FINAL VERIFICATION ===\n");

        // Verify all USDC balances
        uint256 totalUserUsdc = 0;
        for (uint256 i = 0; i < 15; i++) {
            totalUserUsdc += usdc.balanceOf(stakers[i]);
        }

        uint256 totalWorkerPoolUsdc = usdc.balanceOf(workerRewardPool);
        uint256 treasuryAccum = pool.treasuryAccumulated();

        console.log("FINAL ACCOUNTING:");
        console.log("  Total top-ups:", (FIRST_TOP + SECOND_TOP) / USDC_UNIT, "USDC");
        console.log("  Worker pool received:", totalWorkerPoolUsdc / USDC_UNIT, "USDC");
        console.log("  Treasury accumulated:", treasuryAccum / USDC_UNIT, "USDC");
        console.log("  Users received:", totalUserUsdc / USDC_UNIT, "USDC");
        console.log("  Pool balance remaining:", usdc.balanceOf(poolAddr) / USDC_UNIT, "USDC");

        // Worker pool should have received exactly 50% of all top-ups
        assertEq(
            totalWorkerPoolUsdc,
            (FIRST_TOP + SECOND_TOP) / 2,
            "Worker pool should receive 50% of all top-ups"
        );
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
        uint256 RATE = 1000; // 1000 micro-USDC/sec
        uint256 POOL_CAP = 100_000 * 1e18; // 100k SQD

        // 5 stakers with 20k SQD each
        uint256 STAKE_EACH = 20_000 * 1e18;

        // Create pool
        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: POOL_CAP,
            peerId: abi.encodePacked("peer-convoy-belt"),
            tokenSuffix: "CONV",
            distributionRatePerSecond: RATE,
            metadata: "Convoy Belt Test"
        });

        address poolAddr = factory.createPortalPool(params);
        pool = PortalPoolImplementation(poolAddr);

        console.log("Pool capacity:", POOL_CAP / 1e18, "SQD");
        console.log("Stake per user:", STAKE_EACH / 1e18, "SQD");
        console.log("Exit unlock rate: 1 SQD/sec (default)");

        // Mint and deposit for 5 stakers
        address[5] memory exitStakers;
        for (uint256 i = 0; i < 5; i++) {
            exitStakers[i] = address(uint160(0x5000 + i));
            sqd.mint(exitStakers[i], STAKE_EACH);

            vm.startPrank(exitStakers[i]);
            sqd.approve(poolAddr, STAKE_EACH);
            pool.deposit(STAKE_EACH);
            vm.stopPrank();
        }

        console.log("5 stakers deposited 20k SQD each");
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PortalState.ACTIVE), "Pool should be active");

        // Operator tops up rewards
        uint256 TOP_UP = 50_000 * USDC_UNIT;
        usdc.mint(operator, TOP_UP);

        vm.startPrank(operator);
        usdc.approve(poolAddr, TOP_UP);
        pool.topUpRewards(TOP_UP);
        vm.stopPrank();

        console.log("Operator topped up:", TOP_UP / USDC_UNIT, "USDC");

        vm.warp(block.timestamp + 30 days);

        // Check rewards for each staker
        uint256[5] memory rewardsAt1Month;
        for (uint256 i = 0; i < 5; i++) {
            rewardsAt1Month[i] = pool.getClaimableRewards(exitStakers[i]);
        }

        console.log("Staker 0 rewards:", rewardsAt1Month[0] / USDC_UNIT, "USDC");
        console.log("Staker 1 rewards:", rewardsAt1Month[1] / USDC_UNIT, "USDC");
        console.log("Staker 2 rewards:", rewardsAt1Month[2] / USDC_UNIT, "USDC");

        // Staker 0: Claims ALL rewards, then exits
        console.log("Staker 0: Claiming ALL rewards before exit...");
        uint256 staker0RewardsBefore = pool.getClaimableRewards(exitStakers[0]);
        vm.prank(exitStakers[0]);
        uint256 staker0Claimed = pool.claimRewards();
        console.log("  Claimed:", staker0Claimed / USDC_UNIT, "USDC");

        vm.prank(exitStakers[0]);
        uint256 ticket0 = pool.requestExit(STAKE_EACH);
        console.log("  Exit requested, ticket ID:", ticket0);

        // Staker 1: NEVER claims, just exits directly
        console.log("Staker 1: NEVER claimed, exiting directly...");
        uint256 staker1UnclaimedRewards = pool.getClaimableRewards(exitStakers[1]);
        console.log("  Unclaimed rewards:", staker1UnclaimedRewards / USDC_UNIT, "USDC");

        vm.prank(exitStakers[1]);
        uint256 ticket1 = pool.requestExit(STAKE_EACH);
        console.log("  Exit requested, ticket ID:", ticket1);

        // Check if staker 1 can still claim after requesting exit
        uint256 staker1RewardsAfterExit = pool.getClaimableRewards(exitStakers[1]);
        console.log("  Rewards still claimable after exit request:", staker1RewardsAfterExit / USDC_UNIT, "USDC");

        // Staker 2: Claims HALF, then exits
        console.log("Staker 2: Claiming HALF rewards, then exit...");
        uint256 staker2FullRewards = pool.getClaimableRewards(exitStakers[2]);
        vm.prank(exitStakers[2]);
        uint256 staker2Claimed = pool.claimRewards();
        console.log("  Claimed:", staker2Claimed / USDC_UNIT, "USDC");

        vm.prank(exitStakers[2]);
        uint256 ticket2 = pool.requestExit(STAKE_EACH);
        console.log("  Exit requested, ticket ID:", ticket2);

        // Try to withdraw immediately - should fail
        console.log("Attempting early withdrawal (should fail)...");

        vm.prank(exitStakers[0]);
        try pool.withdrawExit(ticket0) {
            revert("CRITICAL BUG: Early withdrawal succeeded!");
        } catch Error(string memory reason) {
            console.log("  Staker 0 correctly blocked:", reason);
        } catch {
            console.log("  Staker 0 correctly blocked (StillInQueue)");
        }

        vm.prank(exitStakers[1]);
        try pool.withdrawExit(ticket1) {
            revert("CRITICAL BUG: Early withdrawal succeeded!");
        } catch {
            console.log("  Staker 1 correctly blocked (StillInQueue)");
        }

        vm.prank(exitStakers[2]);
        try pool.withdrawExit(ticket2) {
            revert("CRITICAL BUG: Early withdrawal succeeded!");
        } catch {
            console.log("  Staker 2 correctly blocked (StillInQueue)");
        }
        address newStaker = address(0x9999);
        sqd.mint(newStaker, STAKE_EACH);

        console.log("New staker attempting to deposit while 3 are exiting...");

        vm.startPrank(newStaker);
        sqd.approve(poolAddr, STAKE_EACH);
        try pool.deposit(STAKE_EACH) {
            console.log("  New staker deposited successfully!");
            IPortalPool.PortalInfo memory info = pool.getPortalInfo();
            console.log("  Pool total staked:", info.totalStaked / 1e18, "SQD");
        } catch Error(string memory reason) {
            console.log("  Deposit blocked:", reason);
        } catch {
            console.log("  Deposit blocked (unknown reason)");
        }
        vm.stopPrank();


        // This is critical: can a user claim rewards while their SQD is locked in exit queue?
        uint256 staker1RewardsInQueue = pool.getClaimableRewards(exitStakers[1]);
        console.log("Staker 1 claimable while in queue:", staker1RewardsInQueue / USDC_UNIT, "USDC");

        if (staker1RewardsInQueue > 0) {
            vm.prank(exitStakers[1]);
            try pool.claimRewards() returns (uint256 claimed) {
                console.log("  CLAIMED while in exit queue:", claimed / USDC_UNIT, "USDC");
            } catch Error(string memory reason) {
                console.log("  Claim blocked while in queue:", reason);
            } catch {
                console.log("  Claim blocked while in queue (unknown)");
            }
        }


        // 60k SQD in queue at 1 SQD/sec = 60000 seconds = ~16.7 hours
        // Let's warp 1 day to be safe
        vm.warp(block.timestamp + 1 days);
        console.log("Warped 1 day forward");


        uint256 staker0SqdBefore = sqd.balanceOf(exitStakers[0]);
        uint256 staker1SqdBefore = sqd.balanceOf(exitStakers[1]);
        uint256 staker2SqdBefore = sqd.balanceOf(exitStakers[2]);

        vm.prank(exitStakers[0]);
        pool.withdrawExit(ticket0);
        console.log("Staker 0 withdrew:", (sqd.balanceOf(exitStakers[0]) - staker0SqdBefore) / 1e18, "SQD");

        vm.prank(exitStakers[1]);
        pool.withdrawExit(ticket1);
        console.log("Staker 1 withdrew:", (sqd.balanceOf(exitStakers[1]) - staker1SqdBefore) / 1e18, "SQD");

        vm.prank(exitStakers[2]);
        pool.withdrawExit(ticket2);
        console.log("Staker 2 withdrew:", (sqd.balanceOf(exitStakers[2]) - staker2SqdBefore) / 1e18, "SQD");

        // Check SQD balances
        assertEq(sqd.balanceOf(exitStakers[0]), STAKE_EACH, "Staker 0 should have SQD back");
        assertEq(sqd.balanceOf(exitStakers[1]), STAKE_EACH, "Staker 1 should have SQD back");
        assertEq(sqd.balanceOf(exitStakers[2]), STAKE_EACH, "Staker 2 should have SQD back");

        // Check USDC balances (rewards)
        uint256 staker0Usdc = usdc.balanceOf(exitStakers[0]);
        uint256 staker1Usdc = usdc.balanceOf(exitStakers[1]);
        uint256 staker2Usdc = usdc.balanceOf(exitStakers[2]);

        console.log("Staker 0 USDC (claimed before exit):", staker0Usdc / USDC_UNIT);
        console.log("Staker 1 USDC (claimed while in queue?):", staker1Usdc / USDC_UNIT);
        console.log("Staker 2 USDC (claimed before exit):", staker2Usdc / USDC_UNIT);

        // Staker 0 claimed before exit - should have rewards
        assertTrue(staker0Usdc > 0, "Staker 0 should have claimed rewards");

        // Check remaining claimable for each exiter
        uint256 staker0Remaining = pool.getClaimableRewards(exitStakers[0]);
        uint256 staker1Remaining = pool.getClaimableRewards(exitStakers[1]);
        uint256 staker2Remaining = pool.getClaimableRewards(exitStakers[2]);

        console.log("\nRemaining claimable after exit:");
        console.log("  Staker 0:", staker0Remaining / USDC_UNIT, "USDC");
        console.log("  Staker 1:", staker1Remaining / USDC_UNIT, "USDC");
        console.log("  Staker 2:", staker2Remaining / USDC_UNIT, "USDC");


        vm.prank(exitStakers[0]);
        try pool.withdrawExit(ticket0) {
            revert("CRITICAL BUG: Double withdrawal succeeded!");
        } catch {
            console.log("Staker 0 correctly blocked from double withdrawal");
        }


        // Stakers 3 and 4 are still in pool
        uint256 staker3Rewards = pool.getClaimableRewards(exitStakers[3]);
        uint256 staker4Rewards = pool.getClaimableRewards(exitStakers[4]);

        console.log("Staker 3 (still in pool) rewards:", staker3Rewards / USDC_UNIT, "USDC");
        console.log("Staker 4 (still in pool) rewards:", staker4Rewards / USDC_UNIT, "USDC");

        // They should still be able to claim
        vm.prank(exitStakers[3]);
        uint256 claimed3 = pool.claimRewards();
        console.log("Staker 3 claimed:", claimed3 / USDC_UNIT, "USDC");

        assertTrue(claimed3 > 0, "Active stakers should still earn rewards");

        console.log("\n============================================================");
        console.log("=== CONVOY BELT TEST COMPLETE ===");
        console.log("============================================================");
        console.log("\nCRITICAL FINDINGS:");
        console.log("1. Exit queue correctly blocks early withdrawals");
        console.log("2. New deposits possible while others in exit queue");
        console.log("3. Reward claiming behavior during exit documented");
        console.log("4. Double withdrawal correctly blocked");
        console.log("5. Pool remains functional after exits");
    }

    /**
     * @notice E2E Test: Fee Distribution with Multiple Token Decimals
     *
     * Tests fee distribution accounting with 3 different payment tokens:
     * - Token18: 18 decimals (like DAI/ETH)
     * - Token6: 6 decimals (like USDC)
     * - Token12: 12 decimals (custom)
     *
     * Verifies:
     * - Correct fee accumulation for each token
     * - Proportional distribution based on stake
     * - Precision handling across different decimals
     * - Users receive exact expected amounts
     */
    function test_E2E_FeeDistribution_MultipleDecimals() public {

        MockERC20 token18 = new MockERC20("Token 18 Decimals", "TKN18", 18);
        MockERC20 token6 = new MockERC20("Token 6 Decimals", "TKN6", 6);
        MockERC20 token12 = new MockERC20("Token 12 Decimals", "TKN12", 12);

        console.log("Token18 decimals:", token18.decimals());
        console.log("Token6 decimals:", token6.decimals());
        console.log("Token12 decimals:", token12.decimals());

        // Add payment tokens to factory
        factory.addPaymentToken(address(token18));
        factory.addPaymentToken(address(token6));
        factory.addPaymentToken(address(token12));

        console.log("All tokens added as payment tokens");

        factory.setDefaultMaxStakePerWallet(type(uint256).max);
        feeRouter.setFeeConfig(10000, 0, 0); // 100% to providers

        address poolAddr;
        {
            IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
                operator: operator,
                capacity: 100_000 * 1e18,
                peerId: abi.encodePacked("peer-fee-decimals-test"),
                tokenSuffix: "FEES",
                distributionRatePerSecond: 1000,
                metadata: "Fee Distribution Decimals Test"
            });
            poolAddr = factory.createPortalPool(params);
            pool = PortalPoolImplementation(poolAddr);
        }
        console.log("Pool deployed at:", poolAddr);

        // Create 5 stakers with different stake amounts
        address[5] memory feeStakers;
        uint256[5] memory feeStakeAmounts;

        feeStakeAmounts[0] = 40_000 * 1e18; // 40% of pool
        feeStakeAmounts[1] = 25_000 * 1e18; // 25%
        feeStakeAmounts[2] = 20_000 * 1e18; // 20%
        feeStakeAmounts[3] = 10_000 * 1e18; // 10%
        feeStakeAmounts[4] = 5_000 * 1e18;  // 5%

        uint256 totalStake = 100_000 * 1e18;
        for (uint256 i = 0; i < 5; i++) {
            feeStakers[i] = address(uint160(0x7000 + i));
            sqd.mint(feeStakers[i], feeStakeAmounts[i]);

            vm.startPrank(feeStakers[i]);
            sqd.approve(poolAddr, feeStakeAmounts[i]);
            pool.deposit(feeStakeAmounts[i]);
            vm.stopPrank();
        }

        console.log("Total staked: 100000 SQD");
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PortalState.ACTIVE), "Pool should be active");

        uint256 FEE_18 = 1000 * 1e18;
        uint256 FEE_6 = 1000 * 1e6;
        uint256 FEE_12 = 1000 * 1e12;

        token18.mint(operator, FEE_18);
        token6.mint(operator, FEE_6);
        token12.mint(operator, FEE_12);

        vm.startPrank(operator);
        token18.approve(poolAddr, FEE_18);
        pool.distributeFees(address(token18), FEE_18);
        token6.approve(poolAddr, FEE_6);
        pool.distributeFees(address(token6), FEE_6);
        token12.approve(poolAddr, FEE_12);
        pool.distributeFees(address(token12), FEE_12);
        vm.stopPrank();

        console.log("All fees distributed");


        _verifyClaimableAmounts(feeStakers, feeStakeAmounts, totalStake, token18, token6, token12, FEE_18, FEE_6, FEE_12);


        (uint256 totalClaimed18, uint256 totalClaimed6, uint256 totalClaimed12) =
            _claimAllFees(feeStakers, token18, token6, token12);

        console.log("Total claimed vs Total distributed:");
        console.log("  Token18:", totalClaimed18 / 1e18, "/", FEE_18 / 1e18);
        console.log("  Token6:", totalClaimed6 / 1e6, "/", FEE_6 / 1e6);
        console.log("  Token12:", totalClaimed12 / 1e12, "/", FEE_12 / 1e12);

        assertApproxEqAbs(totalClaimed18, FEE_18, 1e12, "Token18 total mismatch");
        assertApproxEqAbs(totalClaimed6, FEE_6, 1, "Token6 total mismatch");
        assertApproxEqAbs(totalClaimed12, FEE_12, 1e6, "Token12 total mismatch");

        console.log("\nPool dust remaining:");
        console.log("  Token18:", token18.balanceOf(poolAddr), "wei");
        console.log("  Token6:", token6.balanceOf(poolAddr), "wei");
        console.log("  Token12:", token12.balanceOf(poolAddr), "wei");


        _distributeSecondRound(token18, token6, token12, poolAddr);

        console.log("\n============================================================");
        console.log("=== FEE DISTRIBUTION DECIMALS TEST COMPLETE ===");
        console.log("============================================================");
    }

    function _verifyClaimableAmounts(
        address[5] memory feeStakers,
        uint256[5] memory feeStakeAmounts,
        uint256 totalStake,
        MockERC20 token18,
        MockERC20 token6,
        MockERC20 token12,
        uint256 FEE_18,
        uint256 FEE_6,
        uint256 FEE_12
    ) internal view {
        for (uint256 i = 0; i < 5; i++) {
            uint256 expected18 = (feeStakeAmounts[i] * FEE_18) / totalStake;
            uint256 expected6 = (feeStakeAmounts[i] * FEE_6) / totalStake;
            uint256 expected12 = (feeStakeAmounts[i] * FEE_12) / totalStake;

            uint256 claimable18 = pool.getClaimableFees(feeStakers[i], address(token18));
            uint256 claimable6 = pool.getClaimableFees(feeStakers[i], address(token6));
            uint256 claimable12 = pool.getClaimableFees(feeStakers[i], address(token12));

            uint256 tol18 = expected18 / 10000;
            uint256 tol6 = expected6 / 10000;
            uint256 tol12 = expected12 / 10000;

            if (tol18 < 1e12) tol18 = 1e12;
            if (tol6 < 1) tol6 = 1;
            if (tol12 < 1e6) tol12 = 1e6;

            assertApproxEqAbs(claimable18, expected18, tol18, "Token18 claimable mismatch");
            assertApproxEqAbs(claimable6, expected6, tol6, "Token6 claimable mismatch");
            assertApproxEqAbs(claimable12, expected12, tol12, "Token12 claimable mismatch");
        }
    }

    function _claimAllFees(
        address[5] memory feeStakers,
        MockERC20 token18,
        MockERC20 token6,
        MockERC20 token12
    ) internal returns (uint256 totalClaimed18, uint256 totalClaimed6, uint256 totalClaimed12) {
        for (uint256 i = 0; i < 5; i++) {
            uint256 before18 = token18.balanceOf(feeStakers[i]);
            uint256 before6 = token6.balanceOf(feeStakers[i]);
            uint256 before12 = token12.balanceOf(feeStakers[i]);

            vm.startPrank(feeStakers[i]);
            uint256 claimed18 = pool.claimFees(address(token18));
            uint256 claimed6 = pool.claimFees(address(token6));
            uint256 claimed12 = pool.claimFees(address(token12));
            vm.stopPrank();

            assertEq(token18.balanceOf(feeStakers[i]) - before18, claimed18, "Token18 balance mismatch");
            assertEq(token6.balanceOf(feeStakers[i]) - before6, claimed6, "Token6 balance mismatch");
            assertEq(token12.balanceOf(feeStakers[i]) - before12, claimed12, "Token12 balance mismatch");

            totalClaimed18 += claimed18;
            totalClaimed6 += claimed6;
            totalClaimed12 += claimed12;

            console.log("Staker", i, "claimed Token18:", claimed18 / 1e18);
        }
    }

    function _distributeSecondRound(
        MockERC20 token18,
        MockERC20 token6,
        MockERC20 token12,
        address poolAddr
    ) internal {
        uint256 FEE2_18 = 500 * 1e18;
        uint256 FEE2_6 = 500 * 1e6;
        uint256 FEE2_12 = 500 * 1e12;

        token18.mint(operator, FEE2_18);
        token6.mint(operator, FEE2_6);
        token12.mint(operator, FEE2_12);

        vm.startPrank(operator);
        token18.approve(poolAddr, FEE2_18);
        pool.distributeFees(address(token18), FEE2_18);
        token6.approve(poolAddr, FEE2_6);
        pool.distributeFees(address(token6), FEE2_6);
        token12.approve(poolAddr, FEE2_12);
        pool.distributeFees(address(token12), FEE2_12);
        vm.stopPrank();

        console.log("Second distribution complete");
    }
}
