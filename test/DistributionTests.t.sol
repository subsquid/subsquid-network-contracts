// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PortalImplementation.sol";
import "../src/PortalFactory.sol";
import "../src/GatewayRegistry.sol";
import "../src/FeeRouterModule.sol";
import "../test/mocks/MockNetworkController.sol";
import "../test/mocks/MockERC20.sol";

contract DistributionTests is Test {
    PortalImplementation public portalImpl;
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public usdc;

    address public operator = address(0x1);
    address public provider1 = address(0x2);
    address public provider2 = address(0x3);
    address public provider3 = address(0x4);
    address public workerRewardPool = address(0x5);

    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;

    function setUp() public {
        sqd = new MockERC20("Subsquid", "SQD", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);
        registry = new GatewayRegistry(address(sqd), address(networkController), MIN_STAKE, MANA);
        feeRouter = new FeeRouterModule();
        portalImpl = new PortalImplementation();

        factory = new PortalFactory(
            address(portalImpl),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            MIN_STAKE
        );

        // Mint tokens
        sqd.mint(provider1, 1_000_000 ether);
        sqd.mint(provider2, 1_000_000 ether);
        sqd.mint(provider3, 1_000_000 ether);
        usdc.mint(operator, 1_000_000e6);

        // Approve registry for all providers
        vm.prank(provider1);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(provider2);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(provider3);
        sqd.approve(address(registry), type(uint256).max);
    }

    function _makeTokenArray(address token) internal pure returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        return tokens;
    }

    // ============ Fee Split Tests ============

    function testFeeSplitCalculation() public {
        // Default split: 50% providers, 50% workers, 0% burn
        uint256 amount = 1000e6; // 1000 USDC

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 500e6, "Providers should get 50%");
        assertEq(toWorkerPool, 500e6, "Workers should get 50%");
        assertEq(toBurn, 0, "Burn should be 0%");
        assertEq(toProviders + toWorkerPool + toBurn, amount, "Sum should equal total");
    }

    function testFeeSplitWithOddAmount() public {
        // Test rounding with odd amounts
        uint256 amount = 101; // Odd number to test rounding

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        // Sum should not exceed original amount (rounding down is safe)
        assertTrue(toProviders + toWorkerPool + toBurn <= amount, "Sum should not exceed amount");
        // Rounding error should be minimal
        assertTrue(amount - (toProviders + toWorkerPool + toBurn) < 3, "Rounding error should be < 3");
    }

    function testFeeSplitWithSmallAmount() public {
        // Very small amount
        uint256 amount = 1;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertTrue(toProviders + toWorkerPool + toBurn <= amount, "Sum should not exceed amount");
    }

    function testFeeSplitWithLargeAmount() public {
        // Very large amount
        uint256 amount = 1_000_000_000e6; // 1 billion USDC

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders + toWorkerPool + toBurn, amount, "Sum should equal total for large amounts");
    }

    // ============ Single Provider Distribution ============

    function testSingleProviderDistribution() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "single provider test"
        );

        // Provider stakes
        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Operator distributes fees
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        uint256 feeAmount = 1000e6;
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), feeAmount);

        // Check claimable (should be 50% of fees = 500 USDC)
        uint256 claimable = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));

        // With 50% to providers, single provider gets all of that
        assertEq(claimable, 500e6, "Single provider should get 50% of fees");

        // Claim and verify
        vm.prank(provider1);
        uint256 claimed = PortalImplementation(portal).claimFees(address(usdc));

        assertEq(claimed, 500e6, "Claimed amount should match");
        assertEq(usdc.balanceOf(provider1), 500e6, "Provider balance should reflect claimed fees");
    }

    // ============ Multiple Provider Proportional Distribution ============

    function testTwoProviderEqualDistribution() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE * 2, // Capacity for 2 providers
            block.number + 100,
            "two provider test"
        );

        // Two providers stake equal amounts
        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(provider2);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Distribute fees
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        uint256 feeAmount = 1000e6;
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), feeAmount);

        // Each provider should get half of the provider portion (50% of 50% = 25%)
        uint256 claimable1 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        uint256 claimable2 = PortalImplementation(portal).getClaimableFees(provider2, address(usdc));

        assertEq(claimable1, 250e6, "Provider 1 should get 25% of total fees");
        assertEq(claimable2, 250e6, "Provider 2 should get 25% of total fees");
        assertEq(claimable1, claimable2, "Equal stakers should get equal rewards");
    }

    function testThreeProviderUnequalDistribution() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE * 4, // Capacity for unequal stakes
            block.number + 100,
            "unequal distribution test"
        );

        // Provider 1: 50% of stake
        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE * 2);

        // Provider 2: 25% of stake
        vm.prank(provider2);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Provider 3: 25% of stake
        vm.prank(provider3);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Distribute fees
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        uint256 feeAmount = 1000e6;
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), feeAmount);

        uint256 claimable1 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        uint256 claimable2 = PortalImplementation(portal).getClaimableFees(provider2, address(usdc));
        uint256 claimable3 = PortalImplementation(portal).getClaimableFees(provider3, address(usdc));

        // Provider 1 has 50% stake, should get 50% of provider portion (250 USDC)
        // Provider 2 & 3 each have 25% stake, should get 25% of provider portion (125 USDC each)
        assertEq(claimable1, 250e6, "Provider 1 (50% stake) should get 250 USDC");
        assertEq(claimable2, 125e6, "Provider 2 (25% stake) should get 125 USDC");
        assertEq(claimable3, 125e6, "Provider 3 (25% stake) should get 125 USDC");

        // Total claimable should equal provider portion
        assertEq(claimable1 + claimable2 + claimable3, 500e6, "Total claimable should be 500 USDC");
    }

    // ============ Multiple Distribution Rounds ============

    function testMultipleDistributionRounds() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "multiple rounds test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        // Round 1: Distribute 1000 USDC
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 claimableAfterRound1 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        assertEq(claimableAfterRound1, 500e6, "After round 1: 500 USDC claimable");

        // Round 2: Distribute another 1000 USDC (without claiming first)
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 claimableAfterRound2 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        assertEq(claimableAfterRound2, 1000e6, "After round 2: 1000 USDC claimable (accumulated)");

        // Claim all
        vm.prank(provider1);
        uint256 claimed = PortalImplementation(portal).claimFees(address(usdc));
        assertEq(claimed, 1000e6, "Should claim accumulated 1000 USDC");

        // Round 3: After claiming, new distribution
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 500e6);

        uint256 claimableAfterRound3 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        assertEq(claimableAfterRound3, 250e6, "After round 3: 250 USDC claimable");
    }

    // ============ Exit Queue Exclusion Tests ============

    function testExitRequestExcludedFromFees() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE * 2,
            block.number + 100,
            "exit exclusion test"
        );

        // Both providers stake equal amounts
        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(provider2);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Provider 1 requests exit for all their stake
        vm.prank(provider1);
        PortalImplementation(portal).requestExit(MIN_STAKE);

        // Distribute fees after exit request
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        // Provider 1 (in exit queue) should get nothing
        uint256 claimable1 = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));

        // Provider 2 (active) should get all provider fees
        uint256 claimable2 = PortalImplementation(portal).getClaimableFees(provider2, address(usdc));

        assertEq(claimable1, 0, "Provider in exit queue should get no fees");
        assertEq(claimable2, 500e6, "Active provider should get all provider fees");
    }

    function testPartialExitReducesFeeShare() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE * 2,
            block.number + 100,
            "partial exit test"
        );

        // Provider 1 stakes double
        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE * 2);

        // Provider 1 requests exit for half their stake
        vm.prank(provider1);
        PortalImplementation(portal).requestExit(MIN_STAKE);

        // Active stake is now MIN_STAKE (half in exit queue)
        uint256 activeStake = PortalImplementation(portal).getActiveStake();
        assertEq(activeStake, MIN_STAKE, "Active stake should be half after partial exit request");

        // Distribute fees
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        // Provider should only get fees based on active stake
        uint256 claimable = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        assertEq(claimable, 500e6, "Should get fees based on active stake only");
    }

    // ============ Edge Cases ============

    function testDistributionWithZeroActiveStake() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "zero active stake test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Request exit for entire stake
        vm.prank(provider1);
        PortalImplementation(portal).requestExit(MIN_STAKE);

        // Active stake should be 0
        uint256 activeStake = PortalImplementation(portal).getActiveStake();
        assertEq(activeStake, 0, "Active stake should be 0");

        // Distribution should still work (fees go to workers/burn, none to providers)
        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        // No one should have claimable fees
        uint256 claimable = PortalImplementation(portal).getClaimableFees(provider1, address(usdc));
        assertEq(claimable, 0, "No claimable when all stake is in exit queue");
    }

    function testWorkerPoolReceivesFees() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "worker pool test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        uint256 workerPoolBalanceBefore = usdc.balanceOf(workerRewardPool);

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 workerPoolBalanceAfter = usdc.balanceOf(workerRewardPool);

        // Worker pool should receive 50% of fees
        assertEq(
            workerPoolBalanceAfter - workerPoolBalanceBefore,
            500e6,
            "Worker pool should receive 50% of fees"
        );
    }

    function testCannotDistributeZeroAmount() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "zero amount test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.InvalidAmount.selector);
        PortalImplementation(portal).distributeFees(address(usdc), 0);
    }

    function testCannotDistributeUnallowedToken() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "unallowed token test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Try to distribute DAI (not in allowed tokens)
        MockERC20 dai = new MockERC20("DAI", "DAI", 18);
        dai.mint(operator, 1000 ether);

        vm.prank(operator);
        dai.approve(portal, type(uint256).max);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.TokenNotAllowed.selector);
        PortalImplementation(portal).distributeFees(address(dai), 1000 ether);
    }

    function testOnlyOperatorCanDistribute() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "operator only test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Provider tries to distribute (should fail)
        usdc.mint(provider1, 1000e6);
        vm.prank(provider1);
        usdc.approve(portal, type(uint256).max);

        vm.prank(provider1);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);
    }

    // ============ Tracking Variables Tests ============

    function testTotalFeesDistributedTracking() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "tracking test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        // First distribution
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 total1 = PortalImplementation(portal).totalFeesDistributed(address(usdc));
        assertEq(total1, 500e6, "Total distributed to providers should be 500");

        // Second distribution
        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 500e6);

        uint256 total2 = PortalImplementation(portal).totalFeesDistributed(address(usdc));
        assertEq(total2, 750e6, "Total distributed should accumulate (500 + 250)");
    }

    function testLastDistributionTimeTracking() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(usdc)),
            MIN_STAKE,
            block.number + 100,
            "time tracking test"
        );

        vm.prank(provider1);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        uint256 timeBefore = PortalImplementation(portal).lastDistributionTime(address(usdc));
        assertEq(timeBefore, 0, "Should be 0 before any distribution");

        vm.warp(block.timestamp + 1 days);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 timeAfter = PortalImplementation(portal).lastDistributionTime(address(usdc));
        assertEq(timeAfter, block.timestamp, "Should record distribution timestamp");
    }
}
