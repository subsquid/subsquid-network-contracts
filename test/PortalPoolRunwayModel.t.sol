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

contract PortalPoolRunwayModelTest is Test {
    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;

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
    uint256 constant RATE_PER_SEC = 100;
    uint256 constant MANA = 1000;
    uint256 constant MAX_STAKE_PER_WALLET = 10_000_000;

    PortalPoolImplementation public pool;

    function setUp() public {
        sqd = new MockERC20("Subsquid", "SQD", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);

        registry = new PortalRegistry(address(sqd), address(networkController), MIN_STAKE, MANA);

        feeRouter = new FeeRouterModule();
        feeRouter.setFeeConfig(10000, 0, 0);

        implementation = new PortalPoolImplementation();

        factory = new PortalPoolFactory(
            address(implementation),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            MAX_STAKE_PER_WALLET
        );

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setWorkerPoolAddress(workerRewardPool);

        sqd.mint(operator, 100_000_000);
        sqd.mint(alice, 10_000_000);
        sqd.mint(bob, 10_000_000);
        sqd.mint(charlie, 10_000_000);
        usdc.mint(operator, 100_000_000);

        pool = PortalPoolImplementation(_createAndActivatePortal());

        vm.label(address(pool), "Pool");
        vm.label(operator, "Operator");
        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
    }

    function _createAndActivatePortal() internal returns (address portalAddress) {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-test"),
            tokenSuffix: "TEST",
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: "",
            rewardToken: address(usdc)
        });

        portalAddress = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY);
        IPortalPool(portalAddress).deposit(CAPACITY);
        vm.stopPrank();
    }

    function test_InitialState() public view {
        assertEq(pool.totalDistributionRatePerSec(), RATE_PER_SEC);
        // Delegators get 100% of distribution rate (FeeRouter already split for worker pool)
        assertEq(pool.delegatorRatePerSec(), RATE_PER_SEC);
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
        uint256 expectedRate = RATE_PER_SEC;

        vm.warp(block.timestamp + 1000);

        uint256 claimable = pool.getClaimableRewards(alice);
        uint256 expectedRewards = expectedRate * 1000;

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
        uint256 expectedDrainRate = pool.treasuryRatePerSec() + (pool.delegatorRatePerSec() * CAPACITY / CAPACITY);

        assertEq(drainRate, expectedDrainRate, "Drain rate should match formula");
        assertEq(drainRate, RATE_PER_SEC, "Drain rate should equal total rate at full capacity");
    }

    function test_DryPeriod_RewardsFlatten() public {
        uint256 topUpAmount = 1000;
        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwayDuration = topUpAmount / drainRate;

        vm.warp(block.timestamp + runwayDuration + 1000);

        (int256 balance, uint256 debt,, bool isDry) = pool.getRewardStatus();

        assertTrue(isDry, "Should be dry");
        assertTrue(balance <= 0, "Balance should be <= 0");
        assertTrue(debt > 0, "Should have debt");
    }

    function test_DryPeriod_ClaimableStaysConstant() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 750);
        pool.topUpRewards(750);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 750 / drainRate;

        vm.warp(block.timestamp + runwaySeconds + 100);
        uint256 claimableDay1 = pool.getClaimableRewards(alice);

        vm.warp(block.timestamp + 10000);
        uint256 claimableDay2 = pool.getClaimableRewards(alice);

        assertEq(claimableDay2, claimableDay1, "Claimable should stay constant when dry");
    }

    function test_CatchUp_RetroactiveCompensation() public {
        uint256 START_TIME = block.timestamp;

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 initialTopUp = drainRate * 1000;

        vm.startPrank(operator);
        usdc.approve(address(pool), initialTopUp);
        pool.topUpRewards(initialTopUp);
        vm.stopPrank();

        vm.warp(START_TIME + 1500);

        uint256 rewardsDuringDry = pool.getClaimableRewards(alice);

        uint256 debtBefore = pool.getRewardDebt();
        assertTrue(debtBefore > 0, "Should have debt");

        uint256 largeTopUp = debtBefore + drainRate * 2000;
        vm.startPrank(operator);
        usdc.approve(address(pool), largeTopUp);
        pool.topUpRewards(largeTopUp);
        vm.stopPrank();

        int256 runwayAfter = pool.getRunway();
        assertTrue(runwayAfter > int256(block.timestamp), "Runway should be in future after top-up");

        uint256 rewardsAfterTopUp = pool.getClaimableRewards(alice);
        assertTrue(rewardsAfterTopUp > rewardsDuringDry, "Should have catch-up rewards");
    }

    function test_CatchUp_TopUpRestoresRewards() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 75000);
        pool.topUpRewards(75000);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 75000 / drainRate;

        vm.warp(block.timestamp + runwaySeconds + 500);

        uint256 claimableWhileDry = pool.getClaimableRewards(alice);
        (,,, bool isDry) = pool.getRewardStatus();
        assertTrue(isDry, "Should be dry");

        uint256 debtBefore = pool.getRewardDebt();
        uint256 topUp = debtBefore + 100000;

        vm.startPrank(operator);
        usdc.approve(address(pool), topUp);
        pool.topUpRewards(topUp);
        vm.stopPrank();

        (,,, bool isDryAfter) = pool.getRewardStatus();
        assertFalse(isDryAfter, "Should not be dry after top-up");

        uint256 claimableAfterTopUp = pool.getClaimableRewards(alice);
        assertTrue(claimableAfterTopUp > claimableWhileDry, "Should have retroactive compensation");
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

        uint256 rateBefore = pool.delegatorRatePerSec();

        vm.prank(operator);
        pool.setDistributionRate(RATE_PER_SEC * 2);

        uint256 rateAfter = pool.delegatorRatePerSec();

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

        uint256 debt = pool.getRewardDebt();
        assertTrue(debt > 0, "Should have debt when dry");

        (int256 balance,,, bool isDry) = pool.getRewardStatus();
        assertTrue(isDry, "Should be dry");
        assertTrue(balance < 0, "Balance should be negative");
    }

    function test_GetTotalDrainRate() public view {
        uint256 drainRate = pool.getTotalDrainRate();

        assertEq(drainRate, RATE_PER_SEC, "Drain rate should equal total rate at full capacity");
    }

    function test_GetRunway() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        int256 runway = pool.getRunway();
        assertTrue(runway > int256(block.timestamp), "Runway should be in future");

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 1000 / drainRate;
        vm.warp(block.timestamp + runwaySeconds + 1000);

        int256 runwayAfter = pool.getRunway();
        assertTrue(runwayAfter < int256(block.timestamp), "Runway should be in past");
    }

    function test_TopUpRewards_SplitBetweenProvidersAndWorkerPool() public {
        feeRouter.setFeeConfig(5000, 5000, 0);

        uint256 topUpAmount = 10000;
        uint256 workerPoolBalanceBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 workerPoolBalanceAfter = usdc.balanceOf(workerRewardPool);
        assertEq(workerPoolBalanceAfter - workerPoolBalanceBefore, 5000, "Worker pool should receive 50%");

        int256 providerBalance = pool.getCurrentRewardBalance();
        assertEq(providerBalance, 5000, "Provider balance should be 50%");
    }

    function test_TopUpRewards_RevertsIfWorkerPoolNotSet() public {
        feeRouter.setFeeConfig(5000, 5000, 0);

        // Set factory's worker pool address to zero
        factory.setWorkerPoolAddress(address(0));

        vm.startPrank(operator);
        usdc.approve(address(pool), 10000);
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        pool.topUpRewards(10000);
        vm.stopPrank();
    }
}
