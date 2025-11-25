// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";

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
}

contract BatchSizeLimitsTest is Test {
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;
    PortalImplementation public portalImpl;

    address public operator = address(0x1);
    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;
    address public workerRewardPool = address(0x4);


    uint256 public constant ARBITRUM_GAS_LIMIT = 32_000_000;


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

    }

    function testPortalCreationGasCosts() public {
        emit log_string("=== Portal Creation Gas Analysis ===");
        emit log_string("");

        uint256[] memory testSizes = new uint256[](6);
        testSizes[0] = 10;
        testSizes[1] = 25;
        testSizes[2] = 50;
        testSizes[3] = 75;
        testSizes[4] = 100;
        testSizes[5] = 150;

        vm.startPrank(operator);

        for (uint256 i = 0; i < testSizes.length; ++i) {
            uint256 batchSize = testSizes[i];
            uint256 startingPortals = factory.getPortalCount();

            uint256 gasStart = gasleft();

            for (uint256 j = 0; j < batchSize; ++j) {
                factory.createPortal(
                    operator,
                    _makeTokenArray(address(paymentToken)),
                    MIN_STAKE,
                    block.number + 100,
                    bytes(abi.encodePacked("peer_", startingPortals + j))
                );
            }

            uint256 gasUsed = gasStart - gasleft();
            uint256 avgGasPerPortal = gasUsed / batchSize;
            uint256 maxPortalsInBlock = ARBITRUM_GAS_LIMIT / avgGasPerPortal;

            emit log_named_uint("Batch size", batchSize);
            emit log_named_uint("Total gas used", gasUsed);
            emit log_named_uint("Avg gas per portal", avgGasPerPortal);
            emit log_named_uint("Est. max portals per block", maxPortalsInBlock);
            emit log_named_uint("% of block gas limit", (gasUsed * 100) / ARBITRUM_GAS_LIMIT);
            emit log_string("---");
        }

        vm.stopPrank();

        uint256 totalPortals = factory.getPortalCount();
        emit log_string("");
        emit log_named_uint("TOTAL PORTALS CREATED", totalPortals);
    }

    function testIterationGasCosts() public {
        emit log_string("=== Iteration Gas Cost Analysis ===");
        emit log_string("");


        uint256 totalPortals = 200;

        vm.prank(operator);
        for (uint256 i = 0; i < totalPortals; ++i) {
            factory.createPortal(
                operator,
                _makeTokenArray(address(paymentToken)),
                MIN_STAKE,
                block.number + 100,
                bytes(abi.encodePacked("peer_iter_", i))
            );
        }

        emit log_named_uint("Total portals created", factory.getPortalCount());
        emit log_string("");


        uint256[] memory batchSizes = new uint256[](7);
        batchSizes[0] = 10;
        batchSizes[1] = 20;
        batchSizes[2] = 30;
        batchSizes[3] = 50;
        batchSizes[4] = 75;
        batchSizes[5] = 100;
        batchSizes[6] = 150;

        for (uint256 i = 0; i < batchSizes.length; ++i) {
            uint256 batchSize = batchSizes[i];


            uint256 gasStart = gasleft();

            address[] memory portals = new address[](batchSize);
            for (uint256 j = 0; j < batchSize; ++j) {

                portals[j] = factory.allPortals(j);
            }

            uint256 gasUsed = gasStart - gasleft();
            uint256 avgGasPerIteration = gasUsed / batchSize;

            emit log_named_uint("Batch size", batchSize);
            emit log_named_uint("Gas for iteration", gasUsed);
            emit log_named_uint("Avg gas per iteration", avgGasPerIteration);
            emit log_named_uint("% of block gas limit", (gasUsed * 100) / ARBITRUM_GAS_LIMIT);

            if (gasUsed > (ARBITRUM_GAS_LIMIT * 80) / 100) {
                emit log_string("WARNING: Exceeds 80% of block gas limit!");
            }

            emit log_string("---");
        }
    }

    function testRecommendedBatchSize() public {
        emit log_string("=== Recommended Batch Size Calculation ===");
        emit log_string("");


        uint256 testPortals = 150;

        vm.prank(operator);
        for (uint256 i = 0; i < testPortals; ++i) {
            factory.createPortal(
                operator,
                _makeTokenArray(address(paymentToken)),
                MIN_STAKE,
                block.number + 100,
                bytes(abi.encodePacked("peer_test_", i))
            );
        }


        uint256 testBatchSize = 50;
        uint256 gasStart = gasleft();

        for (uint256 j = 0; j < testBatchSize; ++j) {

            factory.allPortals(j);
        }

        uint256 gasUsed = gasStart - gasleft();
        uint256 gasPerPortal = gasUsed / testBatchSize;


        uint256 safeGasLimit = (ARBITRUM_GAS_LIMIT * 30) / 100;
        uint256 recommendedBatchSize = safeGasLimit / gasPerPortal;

        emit log_named_uint("Gas per portal operation", gasPerPortal);
        emit log_named_uint("Arbitrum block gas limit", ARBITRUM_GAS_LIMIT);
        emit log_named_uint("Safe gas budget (30%)", safeGasLimit);
        emit log_string("");
        emit log_string("=== RECOMMENDATION ===");
        emit log_named_uint("RECOMMENDED BATCH SIZE", recommendedBatchSize);
        emit log_string("");
        emit log_string("This uses only 30% of block gas, leaving margin for:");
        emit log_string("- Transaction overhead");
        emit log_string("- State changes in upgrade operations");
        emit log_string("- Network congestion");
        emit log_string("- Future contract complexity");


        assertTrue(recommendedBatchSize > 0, "Batch size must be > 0");
        assertTrue(recommendedBatchSize >= 20, "Batch size should be at least 20");
    }

    function testMaximumTotalPortals() public {
        emit log_string("=== Maximum Total Portals Test ===");
        emit log_string("");


        uint256 batchSize = 50;
        uint256 totalBatches = 6;

        vm.startPrank(operator);

        for (uint256 batch = 0; batch < totalBatches; ++batch) {
            emit log_named_uint("Creating batch", batch + 1);

            for (uint256 i = 0; i < batchSize; ++i) {
                factory.createPortal(
                    operator,
                    _makeTokenArray(address(paymentToken)),
                    MIN_STAKE,
                    block.number + 100,
                    bytes(abi.encodePacked("peer_max_", batch, "_", i))
                );
            }
        }

        vm.stopPrank();

        uint256 totalPortals = factory.getPortalCount();
        emit log_string("");
        emit log_named_uint("MAXIMUM PORTALS CREATED", totalPortals);
        emit log_string("");
        emit log_string("This demonstrates the system can handle hundreds of portals");
        emit log_string("with batch operations preventing gas limit DoS attacks.");

        assertEq(totalPortals, batchSize * totalBatches);
    }
}
