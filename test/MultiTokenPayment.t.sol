// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";
import {PortalStorage} from "../src/storage/PortalStorage.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

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

contract MultiTokenPaymentTest is Test {
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public usdc;
    MockERC20 public dai;
    MockERC20 public usdt;
    MockERC20 public weth;
    MockERC20 public wbtc;
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

    function _makeTokenArray2(address token1, address token2) internal pure returns (address[] memory) {
        address[] memory tokens = new address[](2);
        tokens[0] = token1;
        tokens[1] = token2;
        return tokens;
    }

    function _makeTokenArray3(address token1, address token2, address token3)
        internal
        pure
        returns (address[] memory)
    {
        address[] memory tokens = new address[](3);
        tokens[0] = token1;
        tokens[1] = token2;
        tokens[2] = token3;
        return tokens;
    }

    function setUp() public {
        sqd = new MockERC20("Subsquid", "SQD", 18);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        dai = new MockERC20("Dai Stablecoin", "DAI", 18);
        usdt = new MockERC20("Tether USD", "USDT", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        wbtc = new MockERC20("Wrapped Bitcoin", "WBTC", 8);

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

        sqd.mint(provider, 1_000_000 ether);
        sqd.mint(provider2, 1_000_000 ether);

        usdc.mint(operator, 1_000_000e6);
        dai.mint(operator, 1_000_000 ether);
        usdt.mint(operator, 1_000_000e6);
        weth.mint(operator, 1_000 ether);
        wbtc.mint(operator, 100e8);

        vm.prank(provider);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(provider2);
        sqd.approve(address(registry), type(uint256).max);
    }

    function testSingleTokenPortalCreation() public {
        emit log_string("=== Test 1: Single Token Portal ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Single token portal"
        );

        address[] memory allowedTokens = PortalImplementation(portal).getAllowedPaymentTokens();
        assertEq(allowedTokens.length, 1);
        assertEq(allowedTokens[0], address(usdc));
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(usdc)));
        assertFalse(PortalImplementation(portal).allowedPaymentTokens(address(dai)));

        emit log_string("PASS: Single token portal created correctly");
    }

    function testSingleTokenFeeDistribution() public {
        emit log_string("=== Test 2: Single Token Fee Distribution ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Single token fee test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);
        // Portal auto-activates when stake reaches maxCapacity

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 claimable = PortalImplementation(portal).getClaimableFees(provider, address(usdc));
        emit log_named_uint("Claimable USDC (6 decimals)", claimable);
        assertTrue(claimable > 0);

        vm.prank(provider);
        uint256 claimed = PortalImplementation(portal).claimFees(address(usdc));

        emit log_named_uint("Claimed USDC", claimed);
        assertEq(claimed, claimable);
        assertEq(usdc.balanceOf(provider), claimed);

        emit log_string("PASS: Single token distribution and claiming works");
    }

    function testDualTokenPortalCreation() public {
        emit log_string("=== Test 3: Dual Token Portal (USDC + DAI) ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray2(address(usdc), address(dai)), MIN_STAKE, block.number + 100, "Dual token portal"
        );

        address[] memory allowedTokens = PortalImplementation(portal).getAllowedPaymentTokens();
        assertEq(allowedTokens.length, 2);
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(usdc)));
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(dai)));
        assertFalse(PortalImplementation(portal).allowedPaymentTokens(address(usdt)));

        emit log_string("PASS: Dual token portal created with correct tokens");
    }

    function testDualTokenFeeDistribution() public {
        emit log_string("=== Test 4: Dual Token Fee Distribution ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray2(address(usdc), address(dai)), MIN_STAKE, block.number + 100, "Dual fee test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);
        // Portal auto-activates when stake reaches maxCapacity

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);
        vm.prank(operator);
        dai.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(dai), 500 ether);

        uint256 usdcClaimable = PortalImplementation(portal).getClaimableFees(provider, address(usdc));
        uint256 daiClaimable = PortalImplementation(portal).getClaimableFees(provider, address(dai));

        emit log_named_uint("Claimable USDC", usdcClaimable);
        emit log_named_uint("Claimable DAI", daiClaimable);

        assertTrue(usdcClaimable > 0);
        assertTrue(daiClaimable > 0);

        vm.prank(provider);
        PortalImplementation(portal).claimFees(address(usdc));
        vm.prank(provider);
        PortalImplementation(portal).claimFees(address(dai));

        assertEq(usdc.balanceOf(provider), usdcClaimable);
        assertEq(dai.balanceOf(provider), daiClaimable);

        emit log_string("PASS: Dual token distribution works independently");
    }

    function testTripleTokenPortal() public {
        emit log_string("=== Test 5: Triple Token Portal (USDC + DAI + USDT) ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray3(address(usdc), address(dai), address(usdt)),
            MIN_STAKE,
            block.number + 100,
            "Triple token portal"
        );

        address[] memory allowedTokens = PortalImplementation(portal).getAllowedPaymentTokens();
        assertEq(allowedTokens.length, 3);
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(usdc)));
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(dai)));
        assertTrue(PortalImplementation(portal).allowedPaymentTokens(address(usdt)));

        emit log_string("PASS: Triple token portal created");
    }

    function testFiveTokenPortal() public {
        emit log_string("=== Test 6: Five Token Portal ===");

        address[] memory tokens = new address[](5);
        tokens[0] = address(usdc);
        tokens[1] = address(dai);
        tokens[2] = address(usdt);
        tokens[3] = address(weth);
        tokens[4] = address(wbtc);

        vm.prank(operator);
        address portal = factory.createPortal(operator, tokens, MIN_STAKE, block.number + 100, "Five token portal");

        address[] memory allowedTokens = PortalImplementation(portal).getAllowedPaymentTokens();
        assertEq(allowedTokens.length, 5);

        emit log_string("PASS: Five token portal supports all tokens");
    }

    function testCannotDistributeDisallowedToken() public {
        emit log_string("=== Test 7: Cannot Distribute Disallowed Token ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Restricted token test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);
        // Portal auto-activates when stake reaches maxCapacity

        vm.prank(operator);
        dai.approve(portal, type(uint256).max);

        vm.prank(operator);
        vm.expectRevert();
        PortalImplementation(portal).distributeFees(address(dai), 100 ether);

        emit log_string("PASS: Cannot distribute disallowed token");
    }

    function testCannotClaimDisallowedToken() public {
        emit log_string("=== Test 8: Cannot Claim Disallowed Token ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Claim restriction test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        vm.prank(provider);
        vm.expectRevert();
        PortalImplementation(portal).claimFees(address(dai));

        emit log_string("PASS: Cannot claim disallowed token");
    }

    function testCannotCreatePortalWithZeroTokens() public {
        emit log_string("=== Test 9: Cannot Create Portal With Zero Tokens ===");

        address[] memory emptyTokens = new address[](0);

        vm.prank(operator);
        vm.expectRevert(PortalFactory.NoPaymentTokens.selector);
        factory.createPortal(operator, emptyTokens, MIN_STAKE, block.number + 100, "Empty tokens test");

        emit log_string("PASS: Cannot create portal with empty token array");
    }

    function testCannotCreatePortalWithZeroAddress() public {
        emit log_string("=== Test 10: Cannot Create Portal With Zero Address Token ===");

        address[] memory tokensWithZero = new address[](2);
        tokensWithZero[0] = address(usdc);
        tokensWithZero[1] = address(0);

        vm.prank(operator);
        vm.expectRevert(PortalFactory.InvalidAddress.selector);
        factory.createPortal(operator, tokensWithZero, MIN_STAKE, block.number + 100, "Zero address test");

        emit log_string("PASS: Cannot create portal with zero address token");
    }

    function testMultiProviderMultiTokenDistribution() public {
        emit log_string("=== Test 11: Multi-Provider Multi-Token Distribution ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator,
            _makeTokenArray2(address(usdc), address(dai)),
            MIN_STAKE * 2,
            block.number + 100,
            "Multi-provider test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(60_000 ether);

        vm.prank(provider2);
        PortalImplementation(portal).stake(40_000 ether);

        vm.prank(operator);
        PortalImplementation(portal).activate();

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);
        vm.prank(operator);
        dai.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(dai), 500 ether);

        uint256 p1UsdcClaimable = PortalImplementation(portal).getClaimableFees(provider, address(usdc));
        uint256 p2UsdcClaimable = PortalImplementation(portal).getClaimableFees(provider2, address(usdc));
        uint256 p1DaiClaimable = PortalImplementation(portal).getClaimableFees(provider, address(dai));
        uint256 p2DaiClaimable = PortalImplementation(portal).getClaimableFees(provider2, address(dai));

        emit log_named_uint("Provider1 USDC claimable", p1UsdcClaimable);
        emit log_named_uint("Provider2 USDC claimable", p2UsdcClaimable);
        emit log_named_uint("Provider1 DAI claimable", p1DaiClaimable);
        emit log_named_uint("Provider2 DAI claimable", p2DaiClaimable);

        assertTrue(p1UsdcClaimable > p2UsdcClaimable);
        assertTrue(p1DaiClaimable > p2DaiClaimable);

        emit log_string("PASS: Multi-provider earnings split correctly per token");
    }

    function testDeprecatedGetClaimableFeesReturnsZero() public {
        emit log_string("=== Test 13: Deprecated getClaimableFees Returns Zero ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Deprecated test"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);
        // Portal auto-activates when stake reaches maxCapacity

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        uint256 claimableResult = PortalImplementation(portal).getClaimableFees(provider, address(usdc));
        assertTrue(claimableResult > 0);

        emit log_string("PASS: getClaimableFees works correctly");
    }

    function testCannotInitializeTokensTwice() public {
        emit log_string("=== Test 14: Cannot Initialize Payment Tokens Twice ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(usdc)), MIN_STAKE, block.number + 100, "Double init test"
        );

        address[] memory newTokens = new address[](1);
        newTokens[0] = address(dai);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.AlreadyInitialized.selector);
        PortalImplementation(portal).initializePaymentTokens(newTokens);

        emit log_string("PASS: Cannot initialize tokens twice");
    }

    function testDifferentDecimalTokens() public {
        emit log_string("=== Test 15: Different Decimal Tokens (6, 8, 18) ===");

        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(wbtc);
        tokens[2] = address(dai);

        vm.prank(operator);
        address portal =
            factory.createPortal(operator, tokens, MIN_STAKE, block.number + 100, "Different decimals test");

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);
        // Portal auto-activates when stake reaches maxCapacity

        vm.prank(operator);
        usdc.approve(portal, type(uint256).max);
        vm.prank(operator);
        wbtc.approve(portal, type(uint256).max);
        vm.prank(operator);
        dai.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(usdc), 1000e6);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(wbtc), 1e8);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(dai), 1000 ether);

        uint256 usdcClaimable = PortalImplementation(portal).getClaimableFees(provider, address(usdc));
        uint256 wbtcClaimable = PortalImplementation(portal).getClaimableFees(provider, address(wbtc));
        uint256 daiClaimable = PortalImplementation(portal).getClaimableFees(provider, address(dai));

        emit log_named_uint("USDC claimable (6 dec)", usdcClaimable);
        emit log_named_uint("WBTC claimable (8 dec)", wbtcClaimable);
        emit log_named_uint("DAI claimable (18 dec)", daiClaimable);

        assertTrue(usdcClaimable > 0);
        assertTrue(wbtcClaimable > 0);
        assertTrue(daiClaimable > 0);

        emit log_string("PASS: Different decimal tokens work correctly");
    }
}
