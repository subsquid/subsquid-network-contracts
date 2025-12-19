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
import {IPortalRegistry} from "../src/interfaces/IPortalRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";

abstract contract BaseTest is Test {
    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;

    MockERC20 public sqd;
    MockERC20 public usdc;
    MockERC20 public dai;

    address public admin = address(this);
    address public operator = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public user3 = address(0x4);
    address public workerRewardPool = address(0x5);

    uint256 public constant WORKER_EPOCH_LENGTH = 7200;
    uint256 public constant MIN_STAKE_THRESHOLD = 100_000 ether;
    uint256 public constant MANA = 1000;
    uint256 public constant MAX_POOL_CAPACITY = 10_000_000 ether;
    uint256 public constant DEFAULT_MAX_STAKE_PER_WALLET = 1_000_000 ether;

    uint256 public constant STAKE_AMOUNT = 100_000 ether;
    uint256 public constant SMALL_STAKE = 10_000 ether;
    uint256 public constant LARGE_STAKE = 500_000 ether;

    function setUp() public virtual {
        sqd = new MockERC20("Subsquid", "SQD", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        dai = new MockERC20("Dai Stablecoin", "DAI", 18);

        networkController = new MockNetworkController(WORKER_EPOCH_LENGTH, MIN_STAKE_THRESHOLD, workerRewardPool);

        registry = new PortalRegistry(address(sqd), address(networkController), MIN_STAKE_THRESHOLD, MANA);

        feeRouter = new FeeRouterModule();

        implementation = new PortalPoolImplementation();

        factory = new PortalPoolFactory(
            address(implementation),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            address(usdc),
            DEFAULT_MAX_STAKE_PER_WALLET
        );

        registry.setFactory(address(factory));

        factory.addPaymentToken(address(usdc));
        factory.addPaymentToken(address(dai));

        _mintTokensToUsers();

        vm.label(address(factory), "Factory");
        vm.label(address(implementation), "Implementation");
        vm.label(address(registry), "Registry");
        vm.label(address(feeRouter), "FeeRouter");
        vm.label(address(sqd), "SQD");
        vm.label(address(usdc), "USDC");
        vm.label(address(dai), "DAI");
        vm.label(operator, "Operator");
        vm.label(user1, "User1");
        vm.label(user2, "User2");
        vm.label(user3, "User3");
    }

    function _mintTokensToUsers() internal {
        sqd.mint(operator, 10_000_000 ether);
        sqd.mint(user1, 1_000_000 ether);
        sqd.mint(user2, 1_000_000 ether);
        sqd.mint(user3, 1_000_000 ether);

        usdc.mint(operator, 10_000_000 * 1e6);
        usdc.mint(user1, 1_000_000 * 1e6);

        dai.mint(operator, 10_000_000 ether);
    }

    function _createPortal(address _operator, uint256 _maxCapacity, string memory _name)
        internal
        returns (address portalAddress)
    {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: _operator,
            capacity: _maxCapacity,
            peerId: abi.encodePacked("peer-", _name),
            tokenSuffix: _name,
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        portalAddress = factory.createPortalPool(params);
    }

    function _createAndActivatePortal(address _operator, uint256 _maxCapacity, string memory _name)
        internal
        returns (address portalAddress)
    {
        portalAddress = _createPortal(_operator, _maxCapacity, _name);

        vm.startPrank(user1);
        sqd.approve(portalAddress, _maxCapacity);
        IPortalPool(portalAddress).deposit(_maxCapacity);
        vm.stopPrank();
    }

    function _approveAndDeposit(address user, address portal, uint256 amount) internal {
        vm.startPrank(user);
        sqd.approve(portal, amount);
        IPortalPool(portal).deposit(amount);
        vm.stopPrank();
    }

    function _warpToAfterDeadline(address portal) internal {
        IPortalPool.PortalInfo memory info = IPortalPool(portal).getPortalInfo();
        vm.warp(info.depositDeadline + 1);
    }
}
