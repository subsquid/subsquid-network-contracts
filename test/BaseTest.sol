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
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

abstract contract BaseTest is Test {
    PortalPoolFactory public factory;
    PortalPoolImplementation public implementation;
    PortalRegistry public registry;
    FeeRouterModule public feeRouter;

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

        PortalRegistry registryImpl = new PortalRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, address(sqd), MIN_STAKE_THRESHOLD, MANA)
        );
        registry = PortalRegistry(address(registryProxy));

        feeRouter = new FeeRouterModule();

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
                DEFAULT_MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
        );
        factory = PortalPoolFactory(address(factoryProxy));

        registry.setFactory(address(factory));

        factory.addPaymentToken(address(usdc));
        factory.addPaymentToken(address(dai));

        factory.setWorkerPoolAddress(workerRewardPool);

        factory.setMaxDistributionRate(type(uint256).max);

        factory.setDefaultWhitelistEnabled(false);

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

        // Mint large amounts for tests with high distribution rates
        usdc.mint(admin, type(uint128).max);
        usdc.mint(operator, type(uint128).max);
        usdc.mint(user1, 1_000_000 * 1e6);

        dai.mint(admin, 10_000_000 ether);
        dai.mint(operator, 10_000_000 ether);
    }

    function _createPortal(address _operator, uint256 _capacity, string memory _name)
        internal
        returns (address portalAddress)
    {

        uint256 minRate = (_capacity / 1e12);
        if (minRate < 1000) minRate = 1000; // Minimum 1 token/sec

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: _operator,
            capacity: _capacity,
            peerId: abi.encodePacked("peer-", _name),
            tokenSuffix: _name,
            distributionRatePerSecond: minRate,
            metadata: "",
            rewardToken: address(usdc)
        });

        // Approve initial deposit for rewardToken (1 day of distribution)
        uint256 initialDeposit = params.distributionRatePerSecond * 1 days / 1000;
        usdc.approve(address(factory), initialDeposit);

        portalAddress = factory.createPortalPool(params);
    }

    function _createAndActivatePortal(address _operator, uint256 _capacity, string memory _name)
        internal
        returns (address portalAddress)
    {
        portalAddress = _createPortal(_operator, _capacity, _name);

        vm.startPrank(user1);
        sqd.approve(portalAddress, _capacity);
        IPortalPool(portalAddress).deposit(_capacity);
        vm.stopPrank();
    }

    function _approveAndDeposit(address user, address portal, uint256 amount) internal {
        vm.startPrank(user);
        sqd.approve(portal, amount);
        IPortalPool(portal).deposit(amount);
        vm.stopPrank();
    }

    function _warpToAfterDeadline(address portal) internal {
        IPortalPool.PoolInfo memory info = IPortalPool(portal).getPoolInfo();
        vm.warp(info.depositDeadline + 1);
    }
}
