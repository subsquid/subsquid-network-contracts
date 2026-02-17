// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {IPortalPool} from "../src/interfaces/IPortalPool.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
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

contract PortalPoolRunwayModelTest is Test {
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
    address public charlie = address(0x4);
    address public workerRewardPool = address(0x5);

    uint256 constant MIN_STAKE = 1_000_000;
    uint256 constant CAPACITY = 2_000_000;
    uint256 constant RATE_PER_SEC = 100_000;
    uint256 constant MANA = 1000;
    uint256 constant MAX_STAKE_PER_WALLET = 10_000_000;
    uint256 constant WORKER_EPOCH_LENGTH = 7200;

    PortalPoolImplementation public pool;

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
        feeRouter.setWorkerPoolAddress(workerRewardPool);
        factory.setDefaultWhitelistEnabled(false);

        sqd.mint(operator, 100_000_000);
        sqd.mint(alice, 10_000_000);
        sqd.mint(bob, 10_000_000);
        sqd.mint(charlie, 10_000_000);
        usdc.mint(admin, 100_000_000);
        usdc.mint(operator, 100_000_000);

        pool = PortalPoolImplementation(_createAndActivatePortal());

        vm.label(address(pool), "Pool");
        vm.label(operator, "Operator");
        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
    }

    function _createAndActivatePortal() internal returns (address portalAddress) {
        uint256 initialDeposit = RATE_PER_SEC * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            tokenSuffix: "TEST",
            distributionRatePerSecond: RATE_PER_SEC,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);

        portalAddress = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY);
        IPortalPool(portalAddress).deposit(CAPACITY);
        vm.stopPrank();
    }

    function test_InitialState() public view {
        assertEq(pool.totalDistributionRatePerSec(), RATE_PER_SEC);
        // Providers get 100% of distribution rate (FeeRouter already split for worker pool)
        assertEq(pool.providerRatePerSec(), RATE_PER_SEC);
        assertEq(pool.treasuryRatePerSec(), 0);
        assertEq(pool.getActiveStake(), CAPACITY);
    }

    function test_TopUpIncreasesBalance() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        int256 balance = pool.getCurrentRewardBalance();
        assertTrue(balance > 0, "Balance should be positive after top-up");
    }

    function test_RewardRate_BasedOnCapacity() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100000);
        pool.topUpRewards(100000);
        vm.stopPrank();

        // Delegators get 100% of distribution rate
        // RATE_PER_SEC is scaled by RATE_PRECISION (1000), so divide to get actual rate
        uint256 actualRate = RATE_PER_SEC / 1000;

        vm.warp(block.timestamp + 1000);

        uint256 claimable = pool.getClaimableRewards(alice);
        uint256 expectedRewards = actualRate * 1000;

        assertApproxEqRel(claimable, expectedRewards, 0.01e18, "Claimable should match expected");
    }

    function test_Runway_CalculatedCorrectly() public {
        uint256 topUpAmount = 1000;
        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        assertTrue(drainRate > 0, "Drain rate should be positive");

        int256 runway = pool.getRunway();
        assertTrue(runway > int256(block.timestamp), "Runway should be in the future");
    }

    function test_DrainRate_Formula() public {
        uint256 drainRate = pool.getTotalDrainRate();
        uint256 expectedDrainRate = pool.treasuryRatePerSec() + (pool.providerRatePerSec() * CAPACITY / CAPACITY);

        assertEq(drainRate, expectedDrainRate, "Drain rate should match formula");
        assertEq(drainRate, RATE_PER_SEC, "Drain rate should equal total rate at full capacity");
    }

    function test_DryPeriod_RewardsFlatten() public {
        // Initial credit from pool creation: RATE_PER_SEC * 86400 / 1000 = 8,640,000
        // Don't top up - just use initial credit

        uint256 drainRate = pool.getTotalDrainRate();
        // drainRate = 100,000, initial credit = 8,640,000
        // Runway = 8,640,000 * 1000 / 100,000 = 86,400 seconds
        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;
        uint256 runwayDuration = (initialCredit * 1000) / drainRate;

        vm.warp(block.timestamp + runwayDuration + 1000);

        uint256 remainingCredit = pool.getCredit();
        bool isDry = remainingCredit == 0;

        assertTrue(isDry, "Should be dry");
        assertEq(pool.getDebt(), 0, "Debt always 0");
    }

    function test_DryPeriod_ClaimableStaysConstant() public {
        // Initial credit = RATE_PER_SEC * 86400 / 1000 = 8,640,000
        // Don't top up, use initial credit

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;
        uint256 runwaySeconds = (initialCredit * 1000) / drainRate;

        vm.warp(block.timestamp + runwaySeconds + 100);
        uint256 claimableDay1 = pool.getClaimableRewards(alice);

        vm.warp(block.timestamp + 10000);
        uint256 claimableDay2 = pool.getClaimableRewards(alice);

        assertEq(claimableDay2, claimableDay1, "Claimable should stay constant when dry");
    }

    function test_CatchUp_RetroactiveCompensation() public {
        uint256 START_TIME = block.timestamp;
        uint256 drainRate = pool.getTotalDrainRate();

        // Initial credit = RATE_PER_SEC * 86400 / 1000 = 8,640,000
        // Runway from initial credit = 8,640,000 * 1000 / drainRate = 86,400 seconds
        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;
        uint256 initialRunway = (initialCredit * 1000) / drainRate;

        vm.warp(START_TIME + initialRunway + 1500);

        uint256 rewardsDuringDry = pool.getClaimableRewards(alice);

        assertEq(pool.getCredit(), 0, "Should be dry");

        uint256 largeTopUp = drainRate * 5;
        vm.startPrank(operator);
        usdc.approve(address(pool), largeTopUp);
        pool.topUpRewards(largeTopUp);
        vm.stopPrank();

        int256 runwayAfter = pool.getRunway();
        assertTrue(runwayAfter > int256(block.timestamp), "Runway should be in future after top-up");

        uint256 rewardsAfterTopUp = pool.getClaimableRewards(alice);
        assertEq(rewardsAfterTopUp, rewardsDuringDry, "Top-up must not retroactively increase rewards");

        vm.warp(block.timestamp + 1000);
        uint256 rewardsAfterResume = pool.getClaimableRewards(alice);
        assertTrue(rewardsAfterResume > rewardsAfterTopUp, "Rewards should resume only after top-up");
    }

    function test_CatchUp_TopUpRestoresRewards() public {
        uint256 drainRate = pool.getTotalDrainRate();

        // Initial credit = RATE_PER_SEC * 86400 / 1000 = 8,640,000
        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;
        uint256 initialRunwaySeconds = (initialCredit * 1000) / drainRate;

        // Warp past initial runway + 500 to create debt
        vm.warp(block.timestamp + initialRunwaySeconds + 500);

        uint256 claimableWhileDry = pool.getClaimableRewards(alice);
        (,,, bool isDry) = pool.getRewardStatus();
        assertTrue(isDry, "Should be dry");

        uint256 debtBefore = pool.getDebt();
        uint256 topUp = debtBefore + 100000;

        vm.startPrank(operator);
        usdc.approve(address(pool), topUp);
        pool.topUpRewards(topUp);
        vm.stopPrank();

        (,,, bool isDryAfter) = pool.getRewardStatus();
        assertFalse(isDryAfter, "Should not be dry after top-up");

        uint256 claimableAfterTopUp = pool.getClaimableRewards(alice);
        assertEq(claimableAfterTopUp, claimableWhileDry, "Top-up must not pay retroactive compensation");

        vm.warp(block.timestamp + 1000);
        uint256 claimableAfterResume = pool.getClaimableRewards(alice);
        assertTrue(claimableAfterResume > claimableAfterTopUp, "Rewards should accrue forward after top-up");
    }

    function test_Claim_ResetsPending() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100000);
        pool.topUpRewards(100000);
        vm.stopPrank();

        vm.warp(block.timestamp + 1000);

        uint256 claimable = pool.getClaimableRewards(alice);
        assertTrue(claimable > 0, "Should have claimable rewards");

        vm.prank(alice);
        pool.claimRewards();

        assertEq(pool.getClaimableRewards(alice), 0, "Claimable should be 0 after claim");
    }

    function test_Claim_AccumulatesCorrectly() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10000000);
        pool.topUpRewards(10000000);
        vm.stopPrank();

        vm.warp(101);
        uint256 firstClaimable = pool.getClaimableRewards(alice);
        assertTrue(firstClaimable > 0, "Should have rewards after first period");

        vm.prank(alice);
        uint256 claimed1 = pool.claimRewards();
        assertEq(claimed1, firstClaimable, "Claimed should match claimable");

        vm.warp(201);
        uint256 secondClaimable = pool.getClaimableRewards(alice);
        assertTrue(secondClaimable > 0, "Should have rewards after second period");

        vm.prank(alice);
        uint256 claimed2 = pool.claimRewards();
        assertEq(claimed2, secondClaimable, "Second claimed should match claimable");

        assertApproxEqRel(claimed1, claimed2, 0.1e18, "Both periods should have equal rewards");
    }

    function test_Attack_AllStakeExited_NoCatchUpOnTopUp() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 5000);
        pool.topUpRewards(5000);
        vm.stopPrank();

        vm.prank(alice);
        pool.requestExit(CAPACITY);

        vm.warp(block.timestamp + 10_000);
        uint256 claimableBefore = pool.getClaimableRewards(alice);

        vm.startPrank(operator);
        usdc.approve(address(pool), 50_000);
        pool.topUpRewards(50_000);
        vm.stopPrank();

        uint256 claimableAfter = pool.getClaimableRewards(alice);
        assertEq(claimableAfter, claimableBefore, "top-up must not reward when active stake is zero");
    }

    function test_Attack_DistributionOff_BlocksTopUp() public {
        vm.prank(operator);
        pool.setDistributionRate(0);

        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        vm.expectRevert();
        pool.topUpRewards(1000);
        vm.stopPrank();
    }

    function test_DistributionRateChange() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100000);
        pool.topUpRewards(100000);
        vm.stopPrank();

        uint256 rateBefore = pool.providerRatePerSec();

        vm.prank(operator);
        pool.setDistributionRate(RATE_PER_SEC * 2);

        uint256 rateAfter = pool.providerRatePerSec();

        assertEq(rateAfter, rateBefore * 2, "Rate should double when distribution rate doubles");
    }

    function test_ExitQueue_StopsRewards() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10000000);
        pool.topUpRewards(10000000);
        vm.stopPrank();

        vm.warp(101);
        uint256 rewardsBefore = pool.getClaimableRewards(alice);
        assertTrue(rewardsBefore > 0, "Should have initial rewards");

        vm.prank(alice);
        uint256 firstPeriodClaimed = pool.claimRewards();
        assertEq(firstPeriodClaimed, rewardsBefore, "Should claim first period rewards");

        vm.prank(alice);
        pool.requestExit(CAPACITY / 2);

        assertEq(pool.getActiveStake(), CAPACITY / 2, "Active stake should be halved");

        vm.warp(201);
        uint256 secondPeriodClaimable = pool.getClaimableRewards(alice);

        assertApproxEqRel(secondPeriodClaimable, firstPeriodClaimed / 2, 0.2e18, "Rewards rate should halve");
    }

    function test_GetRewardStatus() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        (int256 balance, uint256 debt, int256 runwayTs, bool isDry) = pool.getRewardStatus();

        assertTrue(balance > 0, "Balance should be positive");
        assertEq(debt, 0, "Debt should be 0 when not dry");
        assertTrue(runwayTs > int256(block.timestamp), "Runway should be in future");
        assertFalse(isDry, "Should not be dry");
    }

    function test_GetRewardDebt_WhenDry() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        vm.warp(block.timestamp + 100000);

        assertEq(pool.getDebt(), 0, "Debt always 0");

        (int256 balance,,, bool isDry) = pool.getRewardStatus();
        assertTrue(isDry, "Should be dry");
        assertEq(balance, 0, "Balance should be zero when dry");
    }

    function test_GetTotalDrainRate() public view {
        uint256 drainRate = pool.getTotalDrainRate();

        assertEq(drainRate, RATE_PER_SEC, "Drain rate should equal total rate at full capacity");
    }

    function test_GetRunway() public {
        int256 runway = pool.getRunway();
        assertTrue(runway > int256(block.timestamp), "Runway should be in future (from initial credit)");

        uint256 drainRate = pool.getTotalDrainRate();
        // Initial credit = RATE_PER_SEC * 86400 / 1000 = 8,640,000
        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;
        uint256 runwaySeconds = (initialCredit * 1000) / drainRate;
        vm.warp(block.timestamp + runwaySeconds + 1000);

        int256 runwayAfter = pool.getRunway();
        assertTrue(runwayAfter < int256(block.timestamp), "Runway should be in past");
    }

    function test_TopUpRewards_SplitBetweenProvidersAndWorkerPool() public {
        feeRouter.setFeeConfig(5000, 5000, 0);

        uint256 initialCredit = RATE_PER_SEC * 86400 / 1000;

        uint256 topUpAmount = 10000;
        uint256 workerPoolBalanceBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 workerPoolBalanceAfter = usdc.balanceOf(workerRewardPool);
        assertEq(workerPoolBalanceAfter - workerPoolBalanceBefore, 5000, "Worker pool should receive 50%");

        int256 providerBalance = pool.getCurrentRewardBalance();
        // Provider balance = initial credit (100% to providers) + 50% of topup
        assertEq(providerBalance, int256(initialCredit + 5000), "Provider balance should be initial + 50% of topup");
    }
}
