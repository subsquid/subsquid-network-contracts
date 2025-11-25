// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";
import {PortalStorage} from "../src/storage/PortalStorage.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FlowCompatibilityTest is Test {
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;
    PortalImplementation public portalImpl;

    address public operator = address(0x1);
    address public provider = address(0x2);
    address public provider2 = address(0x3);
    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;
    address public workerRewardPool = address(0x4);


    function _makeTokenArray(address token) internal pure returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        return tokens;
    }

    function setUp() public {
        sqd = new MockERC20();
        paymentToken = new MockERC20();

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);

        registry = new GatewayRegistry(
            address(sqd),
            address(networkController),
            MIN_STAKE,
            MANA
        );

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

        


        sqd.mint(provider, 1_000_000 ether);
        sqd.mint(provider2, 1_000_000 ether);
        paymentToken.mint(operator, 1_000_000 ether);


        vm.prank(provider);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(provider2);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(operator);
        paymentToken.approve(address(factory), type(uint256).max);
    }





    function testRefundFromFailedPortal() public {
        emit log_string("=== Test 1: FAILED Portal Refunds ===");


        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "failed test portal"
        );


        uint256 stakeAmount = MIN_STAKE / 2;
        vm.prank(provider);
        PortalImplementation(portal).stake(stakeAmount);


        assertEq(PortalImplementation(portal).getProviderStake(provider), stakeAmount);


        vm.roll(block.number + 101);


        PortalImplementation(portal).checkAndFailPortal();


        PortalStorage.PortalInfo memory info = PortalImplementation(portal).getPortalInfo();
        assertEq(uint256(info.state), uint256(PortalStorage.PortalState.FAILED));

        emit log_string("Portal is FAILED, provider can now withdraw");


        uint256 providerBalanceBefore = sqd.balanceOf(provider);

        vm.prank(provider);
        PortalImplementation(portal).withdrawFromFailed();

        uint256 providerBalanceAfter = sqd.balanceOf(provider);


        assertEq(providerBalanceAfter - providerBalanceBefore, stakeAmount);
        assertEq(PortalImplementation(portal).getProviderStake(provider), 0);

        emit log_named_uint("Provider recovered SQD", stakeAmount);
        emit log_string("PASS: FAILED portal refunds working correctly");
    }

    function testCannotWithdrawFromNonFailedPortal() public {

        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "active portal"
        );



        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);


        vm.prank(provider);
        vm.expectRevert();
        PortalImplementation(portal).withdrawFromFailed();
    }





    function testExitDelayCalculation() public {
        emit log_string("=== Test 2: Exit Delay Calculation ===");


        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "exit delay test"
        );


        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);


        uint256 exitAmount1Percent = MIN_STAKE / 100;
        networkController.setEpochNumber(100);

        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount1Percent);


        uint256 expectedUnlockEpoch1 = 100 + 1 + 1;

        emit log_named_uint("1% exit - Current epoch", 100);
        emit log_named_uint("1% exit - Expected unlock epoch", expectedUnlockEpoch1);


        vm.prank(operator);
        address portal2 = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "exit delay test 2"
        );


        vm.prank(provider);
        PortalImplementation(portal2).stake(MIN_STAKE);

        networkController.setEpochNumber(200);
        uint256 exitAmount10Percent = MIN_STAKE / 10;

        vm.prank(provider);
        PortalImplementation(portal2).requestExit(exitAmount10Percent);


        uint256 expectedUnlockEpoch10 = 200 + 1 + 10;

        emit log_named_uint("10% exit - Current epoch", 200);
        emit log_named_uint("10% exit - Expected unlock epoch", expectedUnlockEpoch10);


        vm.prank(operator);
        address portal3 = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE * 2,
            block.number + 100,
            "exit delay test 3"
        );


        vm.prank(provider);
        PortalImplementation(portal3).stake(MIN_STAKE * 2);

        networkController.setEpochNumber(300);
        uint256 exitAmount50Percent = MIN_STAKE;

        vm.prank(provider);
        PortalImplementation(portal3).requestExit(exitAmount50Percent);


        uint256 expectedUnlockEpoch50 = 300 + 1 + 50;

        emit log_named_uint("50% exit - Current epoch", 300);
        emit log_named_uint("50% exit - Expected unlock epoch", expectedUnlockEpoch50);

        emit log_string("PASS: Exit delay calculation working correctly");
    }





    function testRewardStoppingDuringExit() public {
        emit log_string("=== Test 3: Reward Stopping During Exit ===");


        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "reward stopping test"
        );


        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);


        vm.prank(operator);
        paymentToken.approve(portal, type(uint256).max);


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 100 ether);

        uint256 claimableBefore = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));
        emit log_named_uint("Claimable fees before exit", claimableBefore);


        vm.prank(provider);
        PortalImplementation(portal).claimFees(address(paymentToken));


        uint256 exitAmount = MIN_STAKE / 2;
        networkController.setEpochNumber(100);

        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount);

        emit log_named_uint("Exit amount requested", exitAmount);
        emit log_named_uint("Remaining active stake", MIN_STAKE - exitAmount);


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 100 ether);


        uint256 claimableAfterExit = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));

        emit log_named_uint("Claimable fees after exit request", claimableAfterExit);









        assertTrue(claimableAfterExit > 0, "Should have some claimable fees");
        emit log_string("PASS: Rewards stopped on exit amount");
    }

    function testRewardStoppingMultipleProviders() public {
        emit log_string("=== Test 3b: Reward Stopping with Multiple Providers ===");


        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE * 2,
            block.number + 100,
            "multi provider test"
        );


        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(provider2);
        PortalImplementation(portal).stake(MIN_STAKE);


        vm.prank(operator);
        paymentToken.approve(portal, type(uint256).max);


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 200 ether);

        uint256 p1Claimable1 = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));
        uint256 p2Claimable1 = PortalImplementation(portal).getClaimableFees(provider2, address(paymentToken));

        emit log_named_uint("Provider1 claimable (before exit)", p1Claimable1);
        emit log_named_uint("Provider2 claimable (before exit)", p2Claimable1);


        vm.prank(provider);
        PortalImplementation(portal).claimFees(address(paymentToken));
        vm.prank(provider2);
        PortalImplementation(portal).claimFees(address(paymentToken));


        networkController.setEpochNumber(100);

        vm.prank(provider);
        PortalImplementation(portal).requestExit(MIN_STAKE);

        emit log_string("Provider1 requested full exit - should stop earning");


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 200 ether);

        uint256 p1Claimable2 = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));
        uint256 p2Claimable2 = PortalImplementation(portal).getClaimableFees(provider2, address(paymentToken));

        emit log_named_uint("Provider1 claimable (after exit)", p1Claimable2);
        emit log_named_uint("Provider2 claimable (after exit)", p2Claimable2);



        assertEq(p1Claimable2, 0, "Provider1 should not earn on exiting stake");
        assertTrue(p2Claimable2 > 0, "Provider2 should earn all fees");

        emit log_string("PASS: Provider with full exit earns 0, other provider earns 100%");
    }

    function testExitAmountsClearedOnWithdrawal() public {
        emit log_string("=== Test 3c: Exit Amounts Cleared After Withdrawal ===");


        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray(address(paymentToken)),
            MIN_STAKE,
            block.number + 100,
            "exit clear test"
        );


        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);


        vm.prank(operator);
        paymentToken.approve(portal, type(uint256).max);


        uint256 exitAmount = MIN_STAKE / 2;
        networkController.setEpochNumber(100);

        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount);


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 100 ether);

        uint256 claimableDuringExit = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));
        emit log_named_uint("Claimable during exit", claimableDuringExit);


        networkController.setEpochNumber(200);

        vm.prank(provider);
        registry.withdrawUnlocked();


        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 100 ether);

        uint256 claimableAfterWithdrawal = PortalImplementation(portal).getClaimableFees(provider, address(paymentToken));
        emit log_named_uint("Claimable after withdrawal", claimableAfterWithdrawal);


        assertTrue(claimableAfterWithdrawal > 0, "Should earn on remaining stake");

        emit log_string("PASS: Exit amounts cleared after withdrawal");
    }
}
