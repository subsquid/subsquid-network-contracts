pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {IPortalPool} from "../src/interfaces/IPortalPool.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {FullMath} from "../src/libs/FullMath.sol";

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

    function setMinStakeThreshold(uint256 _minStake) external {
        minStakeThreshold = _minStake;
    }
}

contract PortalPoolAdditionalTests is Test {
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
    address public attacker = address(0x666);
    address public workerRewardPool = address(0x5);

    uint256 constant MIN_STAKE = 1_000_000;
    uint256 constant CAPACITY = 2_000_000;
    uint256 constant RATE_PER_SEC = 100;
    uint256 constant MANA = 1000;
    uint256 constant MAX_STAKE_PER_WALLET = 10_000_000;

    PortalPoolImplementation public pool;
    uint256 poolCount;

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
            address(usdc),
            MAX_STAKE_PER_WALLET
        );

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setWorkerPoolAddress(workerRewardPool);

        sqd.mint(operator, 100_000_000 ether);
        sqd.mint(alice, 100_000_000 ether);
        sqd.mint(bob, 100_000_000 ether);
        sqd.mint(attacker, 100_000_000 ether);
        usdc.mint(operator, 100_000_000_000_000);

        pool = PortalPoolImplementation(_createAndActivatePortal());
    }

    function _createAndActivatePortal() internal returns (address portalAddress) {
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-test-", poolCount),
            tokenSuffix: string(abi.encodePacked("TEST", poolCount)),
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: ""
        });

        portalAddress = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(portalAddress, CAPACITY);
        IPortalPool(portalAddress).deposit(CAPACITY);
        vm.stopPrank();
    }

    function test_NegativeDivisionBug_SmallDebt() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 100 / drainRate;

        vm.warp(block.timestamp + runwaySeconds + 1);

        int256 balance = pool.getCurrentRewardBalance();
        assertTrue(balance < 0, "Balance should be negative (debt)");

        int256 runway = pool.getRunway();
        uint64 balanceTs = pool.balanceTs();

        if (balance == -1) {
            int256 expectedFloor = int256(uint256(balanceTs)) + (-1);
            int256 actualWithTruncation = int256(uint256(balanceTs)) + (balance / int256(drainRate));

            console.log("balance:", balance);
            console.log("drainrate:", drainRate);
            console.log("balancets:", balanceTs);
            console.log("expected (floor):", expectedFloor);
            console.log("actual (truncation):", actualWithTruncation);
            console.log("returned runway:", runway);
        }
    }

    function test_NegativeDivisionBug_RunwayInFutureWhenShouldBePast() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        vm.warp(block.timestamp + 2);

        int256 runway = pool.getRunway();
        int256 currentTs = int256(block.timestamp);

        (int256 balance, , , bool isDry) = pool.getRewardStatus();

        console.log("current timestamp:", block.timestamp);
        console.log("runway:", runway);
        console.log("balance:", balance);
        console.log("is dry:", isDry);

        if (balance < 0 && balance > -int256(pool.getTotalDrainRate())) {
            console.log("bug: small negative balance may cause runway to appear in future");
        }
    }

    function test_NegativeDivision_MultipleSmallDebts() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();

        for (uint256 i = 1; i <= 10; i++) {
            uint256 targetDebt = i;
            uint256 timeToDebt = (1000 + targetDebt) / drainRate;

            vm.warp(block.timestamp + timeToDebt + 1);

            int256 balance = pool.getCurrentRewardBalance();
            int256 runway = pool.getRunway();

            int256 expectedRunway = int256(uint256(pool.balanceTs())) + _divFloor(balance, int256(drainRate));

            if (runway != expectedRunway) {
                console.log("debt level:", targetDebt);
                console.log("actual runway:", runway);
                console.log("expected runway:", expectedRunway);
                console.log("difference:", int256(runway) - expectedRunway);
            }

            vm.startPrank(operator);
            usdc.approve(address(pool), 1000);
            pool.topUpRewards(1000);
            vm.stopPrank();
        }
    }

    function _divFloor(int256 a, int256 b) internal pure returns (int256) {
        int256 q = a / b;
        int256 r = a % b;
        if (r != 0 && ((a < 0) != (b < 0))) q -= 1;
        return q;
    }

    function test_FullMathOverflow_PotentialIssue() public pure {
        uint256 maxElapsed = 365 days * 1000;
        uint256 typicalDrainRate = 100;

        uint256 result = maxElapsed * typicalDrainRate;
        console.log("max elapsed * drainrate:", result);
        console.log("max uint256:", type(uint256).max);

        bool wouldOverflow = maxElapsed > type(uint256).max / typicalDrainRate;
        console.log("would overflow:", wouldOverflow);

        if (wouldOverflow) {
            console.log("bug: long time elapsed can overflow drain calculation");
        }
    }

    function test_FullMathOverflow_ExtremeTimeElapsed() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1000);
        pool.topUpRewards(1000);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days * 100);

        try pool.getCurrentRewardBalance() returns (int256 balance) {
            console.log("balance after 100 years:", balance);
        } catch {
            console.log("overflow: getcurrentrewardbalance reverted after 100 years");
        }
    }

    function test_FullMathOverflow_HighDrainRate() public {
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-highrate-", poolCount),
            tokenSuffix: string(abi.encodePacked("HIGH", poolCount)),
            distributionRatePerSecond: type(uint128).max,
            metadata: ""
        });

        address highRatePool = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(highRatePool, CAPACITY);
        IPortalPool(highRatePool).deposit(CAPACITY);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(highRatePool, type(uint256).max);
        PortalPoolImplementation(highRatePool).topUpRewards(1000000);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);

        try PortalPoolImplementation(highRatePool).getCurrentRewardBalance() returns (int256 balance) {
            console.log("balance with high rate:", balance);
        } catch {
            console.log("overflow: high drain rate caused overflow after 1 day");
        }
    }

    function test_FullMathOverflow_RPS_LongDuration() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100_000_000_000);
        pool.topUpRewards(100_000_000_000);
        vm.stopPrank();

        uint256 initialRPS = pool.rewardPerStakeStored();
        console.log("initial rps:", initialRPS);

        vm.warp(block.timestamp + 365 days * 100);

        try pool.getClaimableRewards(alice) returns (uint256 claimable) {
            console.log("claimable after 100 years:", claimable);
        } catch {
            console.log("bug: rps accumulation overflowed after 100 years");
        }
    }

    function test_Precision_ZeroPerStakeRateWad() public {
        uint256 perStakeRateWad = pool.perStakeRateWad();
        console.log("perstakeratewad:", perStakeRateWad);

        assertTrue(perStakeRateWad > 0, "perStakeRateWad should not be zero");

        uint256 delegatorRate = pool.delegatorRatePerSec();
        uint256 capacity = CAPACITY;
        uint256 ACC = 1e18;

        uint256 expectedPSRW = (delegatorRate * ACC) / capacity;
        console.log("expected perstakeratewad:", expectedPSRW);
        assertEq(perStakeRateWad, expectedPSRW, "perStakeRateWad calculation mismatch");
    }

    function test_Precision_PerStakeRateCalculation() public view {
        uint256 delegatorRate = pool.delegatorRatePerSec();
        uint256 capacity = CAPACITY;
        uint256 ACC = 1e18;

        uint256 expectedPSRW = (delegatorRate * ACC) / capacity;
        uint256 actualPSRW = pool.perStakeRateWad();

        console.log("delegator rate:", delegatorRate);
        console.log("capacity:", capacity);
        console.log("expected perstakeratewad:", expectedPSRW);
        console.log("actual perstakeratewad:", actualPSRW);

        assertEq(actualPSRW, expectedPSRW, "perStakeRateWad should match formula");
        assertTrue(actualPSRW > 0, "perStakeRateWad should not be zero");
    }

    function test_Precision_VerySmallRate() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        pool.setDistributionRate(1);
        vm.stopPrank();

        uint256 psrw = pool.perStakeRateWad();
        console.log("perstakeratewad with rate=1:", psrw);

        if (psrw == 0) {
            console.log("warning: very small rate causes zero perstakeratewad");
        }

        vm.warp(block.timestamp + 1 days);
        uint256 claimable = pool.getClaimableRewards(alice);
        console.log("claimable after 1 day with rate=1:", claimable);
    }

    function test_EdgeCase_ExactZeroBalance() public {
        uint256 topUpAmount = 100;
        vm.startPrank(operator);
        usdc.approve(address(pool), topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 exactRunwaySeconds = topUpAmount / drainRate;

        vm.warp(block.timestamp + exactRunwaySeconds);

        int256 balance = pool.getCurrentRewardBalance();
        (int256 statusBalance, uint256 debt, , bool isDry) = pool.getRewardStatus();

        console.log("balance at exact runway:", balance);
        console.log("status balance:", statusBalance);
        console.log("debt:", debt);
        console.log("is dry:", isDry);

        if (balance == 0) {
            assertTrue(isDry, "Should be dry when balance is exactly 0");
        }
    }

    function test_EdgeCase_TransitionFromPositiveToNegative() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 100 / drainRate;

        int256[] memory balances = new int256[](5);
        bool[] memory isDryFlags = new bool[](5);

        uint256[] memory timestamps = new uint256[](5);
        timestamps[0] = block.timestamp + runwaySeconds - 1;
        timestamps[1] = block.timestamp + runwaySeconds;
        timestamps[2] = block.timestamp + runwaySeconds + 1;
        timestamps[3] = block.timestamp + runwaySeconds + 10;
        timestamps[4] = block.timestamp + runwaySeconds + 100;

        for (uint256 i = 0; i < 5; i++) {
            vm.warp(timestamps[i]);
            balances[i] = pool.getCurrentRewardBalance();
            (, , , isDryFlags[i]) = pool.getRewardStatus();

            console.log("---");
            console.log("offset from runway:", int256(timestamps[i]) - int256(block.timestamp + runwaySeconds));
            console.log("balance:", balances[i]);
            console.log("is dry:", isDryFlags[i]);
        }
    }

    function test_Adversarial_FlashLoanDeposit() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1_000_000);
        pool.topUpRewards(1_000_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 1000);

        uint256 aliceClaimableBefore = pool.getClaimableRewards(alice);

        uint256 attackAmount = CAPACITY;
        sqd.mint(attacker, attackAmount);

        vm.startPrank(attacker);
        sqd.approve(address(pool), attackAmount);
        vm.stopPrank();

        uint256 attackerClaimableBefore = pool.getClaimableRewards(attacker);

        vm.warp(block.timestamp + 1);

        uint256 aliceClaimableAfter = pool.getClaimableRewards(alice);
        uint256 attackerClaimableAfter = pool.getClaimableRewards(attacker);

        console.log("alice claimable before:", aliceClaimableBefore);
        console.log("alice claimable after:", aliceClaimableAfter);
        console.log("attacker claimable:", attackerClaimableAfter);

        assertEq(attackerClaimableAfter, 0, "Attacker shouldn't have rewards without deposit");
    }

    function test_Adversarial_RepeatedClaims() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        vm.stopPrank();

        uint256 totalClaimed = 0;

        for (uint256 i = 0; i < 5; i++) {
            vm.warp(101 + i * 100);

            uint256 claimable = pool.getClaimableRewards(alice);
            if (claimable > 0) {
                vm.prank(alice);
                totalClaimed += pool.claimRewards();
            }

            console.log("round", i, "claimed:", claimable);
        }

        console.log("total claimed:", totalClaimed);

        uint256 expectedPerPeriod = (RATE_PER_SEC / 2) * 100;
        console.log("expected per 100s period:", expectedPerPeriod);
        console.log("total expected for 500s:", expectedPerPeriod * 5);

        assertTrue(totalClaimed >= expectedPerPeriod * 4, "Should claim significant rewards");
    }

    function test_Adversarial_DrainAndClaimRace() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        uint256 drainRate = pool.getTotalDrainRate();
        uint256 runwaySeconds = 100 / drainRate;

        vm.warp(block.timestamp + runwaySeconds - 1);

        uint256 claimableJustBeforeDry = pool.getClaimableRewards(alice);

        vm.warp(block.timestamp + 2);

        uint256 claimableJustAfterDry = pool.getClaimableRewards(alice);

        console.log("claimable just before dry:", claimableJustBeforeDry);
        console.log("claimable just after dry:", claimableJustAfterDry);

        assertTrue(claimableJustAfterDry >= claimableJustBeforeDry, "Rewards should not decrease");
        assertTrue(claimableJustAfterDry <= claimableJustBeforeDry + drainRate * 2, "Rewards should not spike");
    }

    function test_Adversarial_ManipulateActiveStake() public {
        sqd.mint(bob, CAPACITY);

        vm.startPrank(bob);
        sqd.approve(address(pool), CAPACITY);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(pool), 1_000_000);
        pool.topUpRewards(1_000_000);
        vm.stopPrank();

        vm.warp(101);

        uint256 aliceRewardsBefore = pool.getClaimableRewards(alice);

        vm.prank(alice);
        pool.claimRewards();

        vm.prank(alice);
        pool.requestExit(CAPACITY / 2);

        vm.warp(201);

        uint256 aliceRewardsAfter = pool.getClaimableRewards(alice);

        uint256 expectedFullRate = RATE_PER_SEC * 100;
        uint256 expectedHalfRate = RATE_PER_SEC * 100 / 2;

        console.log("alice rewards first period:", aliceRewardsBefore);
        console.log("alice rewards second period:", aliceRewardsAfter);
        console.log("expected full rate:", expectedFullRate);
        console.log("expected half rate:", expectedHalfRate);

        assertApproxEqRel(aliceRewardsAfter, expectedHalfRate, 0.2e18, "Rewards should halve after exit request");
    }

    function test_Adversarial_ZeroDistributionRate() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1_000_000);
        pool.topUpRewards(1_000_000);
        vm.stopPrank();

        vm.warp(101);
        uint256 claimableBefore = pool.getClaimableRewards(alice);

        vm.prank(operator);
        pool.setDistributionRate(0);

        vm.warp(201);

        uint256 claimableAfter = pool.getClaimableRewards(alice);
        console.log("claimable before turning off:", claimableBefore);
        console.log("claimable after turning off:", claimableAfter);

        assertEq(claimableAfter, claimableBefore, "No new rewards accrue when distribution is off");

        vm.expectRevert(PortalErrors.DistributionTurnedOff.selector);
        vm.prank(alice);
        pool.claimRewards();
    }

    function test_Adversarial_MassExitAttack() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 drainRateBefore = pool.getTotalDrainRate();

        vm.prank(alice);
        pool.requestExit(CAPACITY - MIN_STAKE);

        uint256 drainRateAfter = pool.getTotalDrainRate();
        uint256 activeStakeAfter = pool.getActiveStake();

        console.log("drain rate before mass exit:", drainRateBefore);
        console.log("drain rate after mass exit:", drainRateAfter);
        console.log("active stake after:", activeStakeAfter);

        assertTrue(drainRateAfter < drainRateBefore, "Drain rate should decrease after exit");
    }

    function test_DebtOverflow_HighRateLongTime() public {
        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-overflow-", poolCount),
            tokenSuffix: string(abi.encodePacked("OVF", poolCount)),
            distributionRatePerSecond: type(uint128).max,
            metadata: ""
        });

        address overflowPool = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(overflowPool, CAPACITY);
        IPortalPool(overflowPool).deposit(CAPACITY);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(overflowPool, 1000);
        PortalPoolImplementation(overflowPool).topUpRewards(1000);
        vm.stopPrank();

        console.log("distribution rate:", PortalPoolImplementation(overflowPool).totalDistributionRatePerSec());
        console.log("drain rate:", PortalPoolImplementation(overflowPool).getTotalDrainRate());

        vm.warp(block.timestamp + 30 days);

        try PortalPoolImplementation(overflowPool).getCurrentRewardBalance() returns (int256 balance) {
            console.log("balance after 30 days (high rate):", balance);
        } catch (bytes memory reason) {
            console.log("overflow in getcurrentrewardbalance after 30 days");
            console.logBytes(reason);
        }

        try PortalPoolImplementation(overflowPool).getClaimableRewards(alice) returns (uint256 claimable) {
            console.log("claimable after overflow:", claimable);
        } catch (bytes memory reason) {
            console.log("overflow in getclaimablerewards");
            console.logBytes(reason);
        }

        try PortalPoolImplementation(overflowPool).getRunway() returns (int256 runway) {
            console.log("runway after overflow:", runway);
        } catch (bytes memory reason) {
            console.log("overflow in getrunway");
            console.logBytes(reason);
        }
    }

    function test_DebtOverflow_CastToInt256() public pure {
        uint256 maxInt256 = uint256(type(int256).max);
        uint256 justOverMax = maxInt256 + 1;

        console.log("int256.max as uint256:", maxInt256);
        console.log("just over max:", justOverMax);

        int256 safeConversion = int256(maxInt256);
        console.log("safe conversion works:", safeConversion);
    }

    function test_DebtOverflow_CastWrapsAboveMax() public {
        uint256 overMax = uint256(type(int256).max) + 1;

        int256 result = this.castToInt256(overMax);

        console.log("input (just over int256.max):", overMax);
        console.log("result (wrapped to negative):", result);
        console.log("int256.min:", type(int256).min);

        assertEq(result, type(int256).min, "Should wrap to int256.min");
        console.log("danger: solidity 0.8 does not revert, it silently wraps!");
        console.log("however, reaching this requires 5.4e30 years with max drain rate");
    }

    function castToInt256(uint256 val) external pure returns (int256) {
        return int256(val);
    }

    function test_DebtOverflow_TimeToBreak() public {
        uint256 maxDrainRate = type(uint128).max;
        uint256 int256Max = uint256(type(int256).max);

        uint256 secondsToOverflow = int256Max / maxDrainRate;
        uint256 yearsToOverflow = secondsToOverflow / 365 days;

        console.log("with max drain rate (uint128.max):");
        console.log("  seconds until overflow:", secondsToOverflow);
        console.log("  years until overflow:", yearsToOverflow);

        assertTrue(yearsToOverflow > 1e15, "Should take astronomically long to overflow");
    }

    function test_DebtOverflow_DrainedExceedsInt256Max() public {
        uint256 elapsed = 365 days * 1000;
        uint256 drainRate = type(uint128).max;

        console.log("elapsed:", elapsed);
        console.log("drain rate:", drainRate);

        bool wouldExceedInt256 = elapsed > type(uint256).max / drainRate;
        console.log("would exceed uint256.max:", wouldExceedInt256);

        if (!wouldExceedInt256) {
            uint256 drained = elapsed * drainRate;
            bool exceedsInt256Max = drained > uint256(type(int256).max);
            console.log("drained amount:", drained);
            console.log("int256.max:", uint256(type(int256).max));
            console.log("exceeds int256.max:", exceedsInt256Max);

            if (exceedsInt256Max) {
                console.log("bug: drained > int256.max, int256(drained) will overflow");
            }
        }
    }

    function test_DebtOverflow_RealisticScenario() public {
        poolCount++;
        uint256 highRate = 1e18;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            peerId: abi.encodePacked("peer-realistic-", poolCount),
            tokenSuffix: string(abi.encodePacked("REAL", poolCount)),
            distributionRatePerSecond: highRate,
            metadata: ""
        });

        address realPool = factory.createPortalPool(params);

        vm.startPrank(alice);
        sqd.approve(realPool, CAPACITY);
        IPortalPool(realPool).deposit(CAPACITY);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(realPool, 1000);
        PortalPoolImplementation(realPool).topUpRewards(1000);
        vm.stopPrank();

        uint256 drainRate = PortalPoolImplementation(realPool).getTotalDrainRate();
        console.log("drain rate with 1e18 distribution:", drainRate);

        uint256 timeToOverflow = uint256(type(int256).max) / drainRate;
        console.log("seconds until int256 overflow:", timeToOverflow);
        console.log("years until int256 overflow:", timeToOverflow / 365 days);

        vm.warp(block.timestamp + 365 days);

        try PortalPoolImplementation(realPool).getCurrentRewardBalance() returns (int256 balance) {
            console.log("balance after 1 year:", balance);
            assertTrue(balance < 0, "Should be in debt");
        } catch {
            console.log("overflow after just 1 year with rate 1e18");
        }
    }

    function test_Boundary_LargeTimestamp() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100_000_000);
        pool.topUpRewards(100_000_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days * 10);

        try pool.getCurrentRewardBalance() returns (int256 balance) {
            console.log("balance after 10 years:", balance);
        } catch {
            console.log("bug: reverted after 10 years (overflow)");
        }
    }

    function test_Boundary_MinimalTopUp() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 1);
        pool.topUpRewards(1);
        vm.stopPrank();

        int256 balance = pool.getCurrentRewardBalance();
        console.log("balance after 1 wei top-up:", balance);

        vm.warp(block.timestamp + 1);

        int256 balanceAfter = pool.getCurrentRewardBalance();
        console.log("balance after 1 second:", balanceAfter);

        assertTrue(balanceAfter <= balance, "Balance should drain");
    }

    function test_Boundary_ZeroCapacityDivision() public view {
        uint256 drainRate = pool.getTotalDrainRate();
        assertTrue(drainRate > 0, "Drain rate should not be zero with active stake");
    }

    function test_StateConsistency_AfterMultipleTopUps() public {
        uint256[] memory topUps = new uint256[](5);
        topUps[0] = 1000;
        topUps[1] = 5000;
        topUps[2] = 100;
        topUps[3] = 50000;
        topUps[4] = 1;

        int256 totalTopUp = 0;

        for (uint256 i = 0; i < topUps.length; i++) {
            vm.startPrank(operator);
            usdc.approve(address(pool), topUps[i]);
            pool.topUpRewards(topUps[i]);
            vm.stopPrank();

            totalTopUp += int256(topUps[i]);

            vm.warp(block.timestamp + 10);
        }

        int256 finalBalance = pool.getCurrentRewardBalance();
        console.log("total topped up:", totalTopUp);
        console.log("final balance:", finalBalance);

        assertTrue(finalBalance <= totalTopUp, "Balance should not exceed total top-ups");
    }

    function test_StateConsistency_RewardDebtTracking() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 10_000_000);
        pool.topUpRewards(10_000_000);
        vm.stopPrank();

        console.log("=== initial state ===");
        console.log("rewardperstakestored:", pool.rewardPerStakeStored());
        console.log("lasteffectiverewardts:", pool.lastEffectiveRewardTs());
        console.log("credit:", pool.credit());
        console.log("debt:", pool.debt());
        console.log("balancets:", pool.balanceTs());

        vm.warp(101);

        console.log("=== after 100s ===");
        console.log("current timestamp:", block.timestamp);
        console.log("runway:", pool.getRunway());

        uint256 claimable1 = pool.getClaimableRewards(alice);
        console.log("claimable1:", claimable1);

        vm.prank(alice);
        pool.claimRewards();

        console.log("=== after claim ===");
        console.log("rewardperstakestored:", pool.rewardPerStakeStored());
        console.log("lasteffectiverewardts:", pool.lastEffectiveRewardTs());
        console.log("credit:", pool.credit());
        console.log("debt:", pool.debt());
        console.log("balancets:", pool.balanceTs());

        uint256 claimable2 = pool.getClaimableRewards(alice);
        console.log("claimable2 (should be 0):", claimable2);
        assertEq(claimable2, 0, "Claimable should be 0 after claim");

        vm.warp(201);

        console.log("=== after another 100s ===");
        console.log("current timestamp:", block.timestamp);
        console.log("runway:", pool.getRunway());

        uint256 claimable3 = pool.getClaimableRewards(alice);
        console.log("claimable3:", claimable3);

        assertApproxEqRel(claimable3, claimable1, 0.1e18, "New rewards should match first period");
    }

    function test_ComputationUnits_LargeTotalStaked() public {
        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        poolCount++;
        uint256 largeCapacity = 1e30;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: largeCapacity,
            peerId: abi.encodePacked("peer-large-cu-", poolCount),
            tokenSuffix: string(abi.encodePacked("LGCU", poolCount)),
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: ""
        });

        address largePool = factory.createPortalPool(params);

        sqd.mint(alice, largeCapacity);
        vm.startPrank(alice);
        sqd.approve(largePool, largeCapacity);
        IPortalPool(largePool).deposit(largeCapacity);
        vm.stopPrank();

        uint256 cus = registry.getComputationUnits(largePool);
        console.log("computation units with 1e30 stake:", cus);

        assertTrue(cus > 0, "CUs should be non-zero for active pool");
    }

    function testFuzz_ComputationUnits_NoOverflow(uint256 stakeAmount) public {
        factory.setDefaultMaxStakePerWallet(type(uint256).max);

        stakeAmount = bound(stakeAmount, 1e18, 1e50);

        poolCount++;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: stakeAmount,
            peerId: abi.encodePacked("peer-fuzz-cu-", poolCount),
            tokenSuffix: string(abi.encodePacked("FZCU", poolCount)),
            distributionRatePerSecond: RATE_PER_SEC,
            metadata: ""
        });

        address fuzzPool = factory.createPortalPool(params);

        sqd.mint(alice, stakeAmount);
        vm.startPrank(alice);
        sqd.approve(fuzzPool, stakeAmount);
        IPortalPool(fuzzPool).deposit(stakeAmount);
        vm.stopPrank();

        uint256 cus = registry.getComputationUnits(fuzzPool);
        assertTrue(cus > 0 || stakeAmount < 1e18, "CUs should be calculable");
    }

    function test_SetDistributionRate_RevertsWhenPoolHasDebt() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);

        assertTrue(pool.getDebt() > 0, "Pool should have debt");
        assertTrue(pool.isOutOfMoney(), "Pool should be out of money");

        vm.prank(operator);
        vm.expectRevert(PortalErrors.PoolHasDebt.selector);
        pool.setDistributionRate(RATE_PER_SEC * 2);
    }

    function test_SetCapacity_RevertsWhenPoolHasDebt() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);

        assertTrue(pool.getDebt() > 0, "Pool should have debt");

        vm.prank(operator);
        vm.expectRevert(PortalErrors.PoolHasDebt.selector);
        pool.setCapacity(CAPACITY * 2);
    }

    function test_SetDistributionRate_WorksAfterPayingDebt() public {
        vm.startPrank(operator);
        usdc.approve(address(pool), 100);
        pool.topUpRewards(100);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        assertTrue(pool.getDebt() > 0, "Pool should have debt");

        vm.startPrank(operator);
        uint256 debtAmount = pool.getDebt();
        usdc.approve(address(pool), debtAmount * 3);
        pool.topUpRewards(debtAmount * 3);
        vm.stopPrank();

        assertEq(pool.getDebt(), 0, "Debt should be 0 after payoff");

        vm.prank(operator);
        pool.setDistributionRate(RATE_PER_SEC * 2);
        assertEq(pool.totalDistributionRatePerSec(), RATE_PER_SEC * 2);
    }
}
