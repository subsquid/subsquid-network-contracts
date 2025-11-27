// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PortalImplementation.sol";
import "../src/PortalFactory.sol";
import "../src/GatewayRegistry.sol";
import "../src/FeeRouterModule.sol";
import "../test/mocks/MockNetworkController.sol";

contract MockERC20 is Test {
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

contract PortalFixesTest is Test {
    PortalImplementation public portalImpl;
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;

    address public operator = address(0x1);
    address public provider = address(0x2);
    address public workerRewardPool = address(0x3);

    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;

    function setUp() public {
        sqd = new MockERC20();
        paymentToken = new MockERC20();

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

        sqd.mint(provider, 10000 ether);
    }

    function _makeTokenArray(address token) internal pure returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        return tokens;
    }

    function testFix1_SingleTransferFlow() public {
        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, bytes("peer1")
        );

        vm.prank(operator);
        PortalImplementation(portal).activate();

        vm.prank(provider);
        sqd.approve(address(registry), 1000 ether);

        uint256 providerBalanceBefore = sqd.balanceOf(provider);
        uint256 registryBalanceBefore = sqd.balanceOf(address(registry));
        uint256 portalBalance = sqd.balanceOf(portal);

        vm.prank(provider);
        PortalImplementation(portal).stake(1000 ether);

        assertEq(sqd.balanceOf(provider), providerBalanceBefore - 1000 ether, "Provider balance decreased");
        assertEq(sqd.balanceOf(address(registry)), registryBalanceBefore + 1000 ether, "Registry received SQD");
        assertEq(sqd.balanceOf(portal), portalBalance, "Portal never holds SQD");
    }

    function testFix3_GetProviderPortalsWorks() public {
        vm.startPrank(operator);
        address portal1 = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, bytes("peer1")
        );

        address portal2 = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, bytes("peer2")
        );

        PortalImplementation(portal1).activate();
        PortalImplementation(portal2).activate();
        vm.stopPrank();

        vm.startPrank(provider);
        sqd.approve(address(registry), 3000 ether);

        PortalImplementation(portal1).stake(1000 ether);
        PortalImplementation(portal2).stake(2000 ether);
        vm.stopPrank();

        address[] memory portals = registry.getProviderPortals(provider);
        assertEq(portals.length, 2, "Should return 2 portals");
        assertTrue(portals[0] == portal1 || portals[1] == portal1, "Should include portal1");
        assertTrue(portals[0] == portal2 || portals[1] == portal2, "Should include portal2");

        uint256 totalAlloc = registry.getTotalAllocation(provider);
        assertEq(totalAlloc, 3000 ether, "Total allocation should be 3000");
    }
}
