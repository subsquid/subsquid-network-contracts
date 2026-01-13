// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {PortalPoolFactory} from "../src/PortalPoolFactory.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {PortalRegistry} from "../src/PortalRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {LiquidPortalToken} from "../src/LiquidPortalToken.sol";
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

contract ActiveStakeCapacityE2ETest is Test {
    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;

    MockERC20 public sqd;
    MockERC20 public usdc;

    address public admin = address(this);
    address public operator = address(0x1);
    address public workerRewardPool = address(0x5);

    address[10] public actors;
    address[10] public replacementActors;

    uint256 constant CAPACITY = 10_000 * 1e18;
    uint256 constant MIN_STAKE = 1_000 * 1e18;
    uint256 constant STAKE_PER_ACTOR = 1_000 * 1e18;
    uint256 constant MANA = 1000;
    uint256 constant RATE_PRECISION = 1000;
    // Minimum rate to satisfy precision: capacity / 1e12 = 1e22 / 1e12 = 1e10
    uint256 constant SCALED_RATE = 1e10;
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant WORKER_EPOCH_LENGTH = 7200;

    uint256 poolCount;
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
                STAKE_PER_ACTOR,
                MIN_STAKE,
                WORKER_EPOCH_LENGTH
            )
        );
        factory = PortalPoolFactory(address(factoryProxy));

        registry.setFactory(address(factory));
        factory.addPaymentToken(address(usdc));
        factory.setWorkerPoolAddress(workerRewardPool);
        factory.setDefaultWhitelistEnabled(false);

        for (uint256 i = 0; i < 10; i++) {
            actors[i] = address(uint160(100 + i));
            sqd.mint(actors[i], STAKE_PER_ACTOR * 3);

            replacementActors[i] = address(uint160(200 + i));
            sqd.mint(replacementActors[i], STAKE_PER_ACTOR * 3);
        }

        sqd.mint(operator, 100_000 * 1e18);
        usdc.mint(admin, 1_000_000 * USDC_UNIT);
        usdc.mint(operator, 1_000_000 * USDC_UNIT);

        pool = _createPool();
    }

    function _createPool() internal returns (PortalPoolImplementation) {
        poolCount++;
        uint256 initialDeposit = SCALED_RATE * 1 days / RATE_PRECISION;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            tokenSuffix: string(abi.encodePacked("AS", poolCount)),
            distributionRatePerSecond: SCALED_RATE,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        address portalAddress = factory.createPortalPool(params);
        return PortalPoolImplementation(portalAddress);
    }

    function _activatePool() internal {
        for (uint256 i = 0; i < 10; i++) {
            vm.startPrank(actors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();
        }
    }

    function _topUpRewards(uint256 amount) internal {
        vm.startPrank(operator);
        usdc.approve(address(pool), amount);
        pool.topUpRewards(amount);
        vm.stopPrank();
    }

    function test_E2E_01_PoolActivation_All10ActorsDeposit_DetailedTokenFlow() public {
        LiquidPortalToken lpt = pool.lptToken();

        for (uint256 i = 0; i < 10; i++) {
            uint256 sqdBefore = sqd.balanceOf(actors[i]);
            uint256 poolSqdBefore = sqd.balanceOf(address(pool));
            uint256 registrySqdBefore = sqd.balanceOf(address(registry));

            vm.startPrank(actors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();

            uint256 sqdAfter = sqd.balanceOf(actors[i]);
            uint256 lptAfter = lpt.balanceOf(actors[i]);
            uint256 poolSqdAfter = sqd.balanceOf(address(pool));
            uint256 registrySqdAfter = sqd.balanceOf(address(registry));

            assertEq(sqdBefore - sqdAfter, STAKE_PER_ACTOR, "SQD deducted correctly");
            assertEq(lptAfter, STAKE_PER_ACTOR, "LPT minted 1:1");

            if (i < 9) {
                assertEq(poolSqdAfter - poolSqdBefore, STAKE_PER_ACTOR, "Pool holds SQD before activation");
            } else {
                assertEq(registrySqdAfter, CAPACITY, "Registry receives all on activation");
            }
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY, "Total staked = capacity");
        assertEq(pool.getActiveStake(), CAPACITY, "Active stake = capacity");
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE), "Pool ACTIVE");
        assertEq(sqd.balanceOf(address(registry)), CAPACITY, "Registry holds all SQD");

        for (uint256 i = 0; i < 10; i++) {
            assertEq(pool.getProviderStake(actors[i]), STAKE_PER_ACTOR, "Each actor has correct stake");
            assertEq(lpt.balanceOf(actors[i]), STAKE_PER_ACTOR, "Each actor has correct LPT");
        }
    }

    function test_E2E_02_All10ActorsExit_ActiveStakeVsTotalStake_Detailed() public {
        _activatePool();
        LiquidPortalToken lpt = pool.lptToken();

        uint256[] memory exitAmounts = new uint256[](10);
        exitAmounts[0] = STAKE_PER_ACTOR;
        exitAmounts[1] = STAKE_PER_ACTOR / 2;
        exitAmounts[2] = STAKE_PER_ACTOR / 4;
        exitAmounts[3] = STAKE_PER_ACTOR;
        exitAmounts[4] = (STAKE_PER_ACTOR * 75) / 100;
        exitAmounts[5] = STAKE_PER_ACTOR / 10;
        exitAmounts[6] = STAKE_PER_ACTOR;
        exitAmounts[7] = (STAKE_PER_ACTOR * 90) / 100;
        exitAmounts[8] = STAKE_PER_ACTOR / 3;
        exitAmounts[9] = STAKE_PER_ACTOR;

        uint256 runningExitTotal = 0;

        for (uint256 i = 0; i < 10; i++) {
            uint256 lptBefore = lpt.balanceOf(actors[i]);
            uint256 stakeBefore = pool.getProviderStake(actors[i]);
            uint256 totalBefore = pool.getPoolInfo().totalStaked;
            uint256 activeBefore = pool.getActiveStake();

            vm.prank(actors[i]);
            pool.requestExit(exitAmounts[i]);

            runningExitTotal += exitAmounts[i];

            uint256 lptAfter = lpt.balanceOf(actors[i]);
            uint256 stakeAfter = pool.getProviderStake(actors[i]);
            uint256 totalAfter = pool.getPoolInfo().totalStaked;
            uint256 activeAfter = pool.getActiveStake();

            assertEq(lptBefore - lptAfter, exitAmounts[i], "LPT burned = exit amount");
            assertEq(totalAfter, totalBefore, "totalStaked unchanged after exit request");
            assertEq(activeBefore - activeAfter, exitAmounts[i], "activeStake decreased by exit amount");
            assertEq(stakeAfter, stakeBefore, "User stake unchanged (still allocated)");
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY, "totalStaked = original capacity");
        assertEq(pool.getActiveStake(), CAPACITY - runningExitTotal, "activeStake = capacity - exits");
    }

    function test_E2E_03_ConvoyBelt_10ExitAnd10Replace_DetailedTokenTransfers() public {
        _activatePool();
        _topUpRewards(100_000 * USDC_UNIT);
        LiquidPortalToken lpt = pool.lptToken();

        for (uint256 i = 0; i < 10; i++) {
            uint256 activeBeforeExit = pool.getActiveStake();

            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR);

            uint256 activeAfterExit = pool.getActiveStake();
            assertEq(activeAfterExit, activeBeforeExit - STAKE_PER_ACTOR, "Active reduced by exit");

            uint256 replacerSqdBefore = sqd.balanceOf(replacementActors[i]);
            uint256 registrySqdBefore = sqd.balanceOf(address(registry));

            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();

            uint256 replacerSqdAfter = sqd.balanceOf(replacementActors[i]);
            uint256 replacerLpt = lpt.balanceOf(replacementActors[i]);
            uint256 registrySqdAfter = sqd.balanceOf(address(registry));
            uint256 activeAfterDeposit = pool.getActiveStake();

            assertEq(replacerSqdBefore - replacerSqdAfter, STAKE_PER_ACTOR, "Replacer spent SQD");
            assertEq(replacerLpt, STAKE_PER_ACTOR, "Replacer received LPT");
            assertEq(registrySqdAfter - registrySqdBefore, STAKE_PER_ACTOR, "Registry received SQD");
            assertEq(activeAfterDeposit, CAPACITY, "Active stake back to capacity");
            assertEq(pool.getProviderStake(replacementActors[i]), STAKE_PER_ACTOR, "Replacer has stake");
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY * 2, "Total = 2x capacity");
        assertEq(pool.getActiveStake(), CAPACITY, "Active = capacity");

        for (uint256 i = 0; i < 10; i++) {
            assertEq(pool.getProviderStake(actors[i]), STAKE_PER_ACTOR, "Original actor stake intact (pending)");
            assertEq(pool.getProviderStake(replacementActors[i]), STAKE_PER_ACTOR, "Replacement actor stake correct");
        }
    }

    function test_E2E_04_RewardDistribution_10Actors_BeforeAndAfterExits() public {
        _activatePool();
        _topUpRewards(1_000_000 * USDC_UNIT);

        vm.warp(block.timestamp + 1000);

        uint256[] memory rewards1 = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            rewards1[i] = pool.getClaimableRewards(actors[i]);
        }

        uint256 expectedPerActor = (SCALED_RATE * 1000 / RATE_PRECISION) / 10;
        for (uint256 i = 0; i < 10; i++) {
            assertApproxEqRel(rewards1[i], expectedPerActor, 0.01e18, "Equal rewards for equal stake");
        }

        for (uint256 i = 0; i < 5; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR);
        }

        vm.warp(block.timestamp + 1000);

        uint256[] memory rewards2 = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            rewards2[i] = pool.getClaimableRewards(actors[i]);
        }

        for (uint256 i = 0; i < 5; i++) {
            assertEq(rewards2[i], rewards1[i], "Exiting actors earned nothing more");
        }
        for (uint256 i = 5; i < 10; i++) {
            assertTrue(rewards2[i] >= rewards1[i], "Active actors earned at least same");
        }

        for (uint256 i = 0; i < 5; i++) {
            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();
        }

        vm.warp(block.timestamp + 1000);

        uint256 totalClaimed = 0;
        for (uint256 i = 0; i < 10; i++) {
            uint256 claimable = pool.getClaimableRewards(actors[i]);
            if (claimable > 0) {
                vm.prank(actors[i]);
                uint256 claimed = pool.claimRewards();
                totalClaimed += claimed;
            }
        }
        for (uint256 i = 0; i < 5; i++) {
            uint256 claimable = pool.getClaimableRewards(replacementActors[i]);
            if (claimable > 0) {
                vm.prank(replacementActors[i]);
                uint256 claimed = pool.claimRewards();
                totalClaimed += claimed;
            }
        }

        assertTrue(totalClaimed > 0, "Rewards were claimed");
    }

    function test_E2E_05_DrainRate_10Actors_ProgressiveExits() public {
        _activatePool();
        _topUpRewards(1_000_000 * USDC_UNIT);

        assertEq(pool.getTotalDrainRate(), SCALED_RATE, "Full rate at full capacity");

        uint256[] memory expectedRates = new uint256[](11);
        expectedRates[0] = SCALED_RATE;
        for (uint256 i = 1; i <= 10; i++) {
            expectedRates[i] = (SCALED_RATE * (10 - i)) / 10;
        }

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR);

            uint256 drainRate = pool.getTotalDrainRate();
            assertEq(drainRate, expectedRates[i + 1], "Drain rate proportional to active stake");
        }

        assertEq(pool.getTotalDrainRate(), 0, "Zero drain when no active stake");
        assertEq(pool.getActiveStake(), 0, "Zero active stake");

        for (uint256 i = 0; i < 10; i++) {
            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();
        }

        assertEq(pool.getTotalDrainRate(), SCALED_RATE, "Full rate restored");
    }

    function test_E2E_06_Runway_10Actors_DynamicCalculation() public {
        _activatePool();
        _topUpRewards(100_000 * USDC_UNIT);

        int256 initialRunway = pool.getRunway();
        uint256 initialRunwaySeconds = uint256(initialRunway) - block.timestamp;

        int256[] memory runways = new int256[](11);
        runways[0] = initialRunway;

        for (uint256 i = 0; i < 9; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR);

            runways[i + 1] = pool.getRunway();
            uint256 activePercent = ((10 - i - 1) * 10);
            uint256 runwaySeconds = uint256(runways[i + 1]) - block.timestamp;

            if (activePercent > 0) {
                uint256 expectedRunway = initialRunwaySeconds * 10 / (10 - i - 1);
                assertApproxEqRel(
                    runwaySeconds, expectedRunway, 0.05e18, "Runway inversely proportional to active stake"
                );
            }
        }

        vm.prank(actors[9]);
        pool.requestExit(STAKE_PER_ACTOR);

        int256 finalRunway = pool.getRunway();
        assertEq(finalRunway, type(int256).max, "Infinite runway when no drain");
    }

    function test_E2E_07_LPTTransfer_10Actors_ExitAndTransfer() public {
        _activatePool();
        _topUpRewards(100_000 * USDC_UNIT);
        LiquidPortalToken lpt = pool.lptToken();

        vm.warp(block.timestamp + 1000);

        for (uint256 i = 0; i < 10; i++) {
            uint256 reward = pool.getClaimableRewards(actors[i]);
            assertTrue(reward > 0, "All actors earned rewards");
        }

        for (uint256 i = 0; i < 5; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR / 2);
        }

        for (uint256 i = 0; i < 5; i++) {
            uint256 transferAmount = STAKE_PER_ACTOR / 4;
            vm.prank(actors[i]);
            lpt.transfer(replacementActors[i], transferAmount);
        }

        for (uint256 i = 0; i < 5; i++) {
            assertEq(lpt.balanceOf(actors[i]), STAKE_PER_ACTOR / 4, "Sender has 25% LPT");
            assertEq(
                pool.getProviderStake(actors[i]),
                (STAKE_PER_ACTOR * 75) / 100,
                "Sender stake = 75% (100% - 25% transferred)"
            );
            assertEq(lpt.balanceOf(replacementActors[i]), STAKE_PER_ACTOR / 4, "Receiver has 25% LPT");
            assertEq(pool.getProviderStake(replacementActors[i]), STAKE_PER_ACTOR / 4, "Receiver stake = 25%");
        }

        vm.prank(actors[0]);
        pool.requestExit(STAKE_PER_ACTOR / 4);

        vm.prank(replacementActors[0]);
        pool.requestExit(STAKE_PER_ACTOR / 4);

        assertEq(
            pool.getProviderStake(actors[0]), (STAKE_PER_ACTOR * 75) / 100, "Actor 0 stake unchanged after 2nd exit"
        );
        assertEq(pool.getProviderStake(replacementActors[0]), STAKE_PER_ACTOR / 4, "Replacement 0 stake unchanged");

        for (uint256 i = 5; i < 10; i++) {
            assertEq(pool.getProviderStake(actors[i]), STAKE_PER_ACTOR, "Actors 5-9 unchanged");
        }
    }

    function test_E2E_08_WithdrawExit_10Actors_FullCycle() public {
        _activatePool();
        _topUpRewards(100_000 * USDC_UNIT);

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR);
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY, "Total unchanged after exits");
        assertEq(pool.getActiveStake(), 0, "Active = 0 after all exits");

        for (uint256 i = 0; i < 10; i++) {
            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR);
            pool.deposit(STAKE_PER_ACTOR);
            vm.stopPrank();
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY * 2, "Total = 2x after replacements");
        assertEq(pool.getActiveStake(), CAPACITY, "Active = capacity after replacements");

        vm.warp(block.timestamp + 365 days);

        for (uint256 i = 0; i < 10; i++) {
            uint256 sqdBefore = sqd.balanceOf(actors[i]);

            vm.prank(actors[i]);
            pool.withdrawExit(0);

            uint256 sqdAfter = sqd.balanceOf(actors[i]);
            assertEq(sqdAfter - sqdBefore, STAKE_PER_ACTOR, "Received full stake back");
        }

        assertEq(pool.getPoolInfo().totalStaked, CAPACITY, "Total = capacity after withdraws");
        assertEq(pool.getActiveStake(), CAPACITY, "Active = capacity after withdraws");

        for (uint256 i = 0; i < 10; i++) {
            assertEq(pool.getProviderStake(actors[i]), 0, "Original actor stake = 0");
            assertEq(pool.getProviderStake(replacementActors[i]), STAKE_PER_ACTOR, "Replacement has stake");
        }
    }

    function test_E2E_09_CreditDebt_10Actors_BalanceTransitions() public {
        _activatePool();

        // Pool now has initial credit from pool creation
        assertTrue(pool.getCredit() > 0, "Should have initial credit from pool creation");
        assertEq(pool.getDebt(), 0, "No initial debt");

        _topUpRewards(10_000 * USDC_UNIT);

        uint256 creditAfterTopup = pool.getCredit();
        assertTrue(creditAfterTopup > 0, "Credit after top-up");

        int256 runway = pool.getRunway();
        uint256 runwaySeconds = uint256(runway) - block.timestamp;

        uint256 halfRunway = runwaySeconds / 2;
        vm.warp(block.timestamp + halfRunway);

        (int256 balance1,,, bool isDry1) = pool.getRewardStatus();
        assertTrue(balance1 > 0, "Balance positive at 50% runway");
        assertFalse(isDry1, "Not dry at 50% runway");

        vm.warp(block.timestamp + halfRunway + 100);

        (int256 balance2, uint256 debt2,, bool isDry2) = pool.getRewardStatus();
        assertTrue(isDry2, "Pool should be dry");
        assertTrue(balance2 < 0, "Balance should be negative (debt)");
        assertTrue(debt2 > 0, "Debt should be positive");

        _topUpRewards(50_000 * USDC_UNIT);

        (int256 balance3,,, bool isDry3) = pool.getRewardStatus();
        assertTrue(balance3 > 0, "Balance should be positive");
        assertFalse(isDry3, "Pool should not be dry");

        uint256 totalClaimed = 0;
        for (uint256 i = 0; i < 10; i++) {
            uint256 claimable = pool.getClaimableRewards(actors[i]);
            if (claimable > 0) {
                vm.prank(actors[i]);
                uint256 claimed = pool.claimRewards();
                totalClaimed += claimed;
            }
        }
        assertTrue(totalClaimed > 0, "Rewards claimed after recovery");
    }

    function test_E2E_10_EdgeCase_SimultaneousOperations_10Actors() public {
        _activatePool();
        _topUpRewards(500_000 * USDC_UNIT);

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR / 2);

            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR / 2);
            pool.deposit(STAKE_PER_ACTOR / 2);
            vm.stopPrank();
        }

        assertEq(pool.getActiveStake(), CAPACITY, "Active stake maintained at capacity");

        vm.warp(block.timestamp + 500);

        uint256 totalOriginalRewards = 0;
        uint256 totalReplacementRewards = 0;

        for (uint256 i = 0; i < 10; i++) {
            totalOriginalRewards += pool.getClaimableRewards(actors[i]);
            totalReplacementRewards += pool.getClaimableRewards(replacementActors[i]);
        }

        assertTrue(totalOriginalRewards > 0, "Original actors earned rewards");
        assertTrue(totalReplacementRewards > 0, "Replacement actors earned rewards");

        vm.warp(block.timestamp + 365 days);

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(actors[i]);
            pool.withdrawExit(0);
        }

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(actors[i]);
            pool.requestExit(STAKE_PER_ACTOR / 2);

            vm.startPrank(replacementActors[i]);
            sqd.approve(address(pool), STAKE_PER_ACTOR / 2);
            pool.deposit(STAKE_PER_ACTOR / 2);
            vm.stopPrank();
        }

        assertEq(pool.getActiveStake(), CAPACITY, "Active stake still at capacity");

        vm.warp(block.timestamp + 1000);

        uint256 grandTotalClaimed = 0;
        for (uint256 i = 0; i < 10; i++) {
            if (pool.getClaimableRewards(actors[i]) > 0) {
                vm.prank(actors[i]);
                grandTotalClaimed += pool.claimRewards();
            }
            if (pool.getClaimableRewards(replacementActors[i]) > 0) {
                vm.prank(replacementActors[i]);
                grandTotalClaimed += pool.claimRewards();
            }
        }

        assertTrue(grandTotalClaimed > 0, "Grand total claimed");
    }
}
