// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

contract GasLimitsTest is Test {
    PortalImplementation public portalImpl;
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;

    address public operator = address(0x1);
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

        networkController = new MockNetworkController(
            7200,
            MIN_STAKE,
            workerRewardPool
        );

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

    function testMaxPortalCreation() public {
        uint256 maxPortals = 100;

        vm.startPrank(operator);
        for (uint256 i = 0; i < maxPortals; ++i) {
            factory.createPortal(
                operator,
                _makeTokenArray(address(paymentToken)),
                MIN_STAKE,
                block.number + 100,
                bytes(abi.encodePacked("peer", i))
            );
        }
        vm.stopPrank();

        assertEq(factory.getPortalCount(), maxPortals);
        emit log_named_uint("Successfully created portals", maxPortals);
    }

    function testMaxBatchUpgradeSize() public {

        uint256 totalPortals = 100;

        vm.startPrank(operator);
        for (uint256 i = 0; i < totalPortals; ++i) {
            factory.createPortal(
                operator,
                _makeTokenArray(address(paymentToken)),
                MIN_STAKE,
                block.number + 100,
                bytes(abi.encodePacked("peer", i))
            );
        }
        vm.stopPrank();


        PortalImplementation newImpl = new PortalImplementation();


        uint256[] memory batchSizes = new uint256[](5);
        batchSizes[0] = 10;
        batchSizes[1] = 20;
        batchSizes[2] = 30;
        batchSizes[3] = 40;
        batchSizes[4] = 50;

        for (uint256 i = 0; i < batchSizes.length; ++i) {
            uint256 batchSize = batchSizes[i];


            uint256 gasBefore = gasleft();

            try factory.upgradePortalsBatch(address(newImpl), 0, batchSize) {
                uint256 gasUsed = gasBefore - gasleft();

                emit log_named_uint("Batch size", batchSize);
                emit log_named_uint("Gas used", gasUsed);
                emit log_named_uint("% of block gas limit (30M)", (gasUsed * 100) / 30_000_000);
                emit log_string("---");
            } catch {
                emit log_named_uint("FAILED at batch size", batchSize);
                break;
            }
        }
    }

    function testFindMaxBatchSize() public {
        // Test gas costs for creating multiple portals in sequence
        // This measures the practical limits of portal creation batches

        uint256[] memory batchSizes = new uint256[](4);
        batchSizes[0] = 25;
        batchSizes[1] = 50;
        batchSizes[2] = 75;
        batchSizes[3] = 100;

        uint256 portalCounter = 0;

        for (uint256 i = 0; i < batchSizes.length; ++i) {
            uint256 batchSize = batchSizes[i];

            uint256 gasBefore = gasleft();
            vm.startPrank(operator);
            for (uint256 j = 0; j < batchSize; ++j) {
                factory.createPortal(
                    operator,
                    _makeTokenArray(address(paymentToken)),
                    MIN_STAKE,
                    block.number + 100,
                    bytes(abi.encodePacked("batch_peer", portalCounter))
                );
                portalCounter++;
            }
            vm.stopPrank();
            uint256 gasUsed = gasBefore - gasleft();

            emit log_named_uint("Batch size", batchSize);
            emit log_named_uint("Gas used", gasUsed);
            emit log_named_uint("Gas per portal", gasUsed / batchSize);
            emit log_string("---");
        }

        emit log_named_uint("Total portals created", factory.getPortalCount());
        assertTrue(factory.getPortalCount() == 250, "Should have created 250 portals total");
    }

    function testForLoopPerformance() public {
        uint256[] memory sizes = new uint256[](4);
        sizes[0] = 50;
        sizes[1] = 100;
        sizes[2] = 150;
        sizes[3] = 200;

        for (uint256 j = 0; j < sizes.length; ++j) {
            uint256 size = sizes[j];

            vm.startPrank(operator);
            for (uint256 i = 0; i < size; ++i) {
                factory.createPortal(
                    operator,
                    _makeTokenArray(address(paymentToken)),
                    MIN_STAKE,
                    block.number + 100,
                    bytes(abi.encodePacked("peer_batch", j, "_", i))
                );
            }
            vm.stopPrank();

            emit log_named_uint("Total portals", size);
            emit log_named_uint("Portal count", factory.getPortalCount());
            emit log_string("---");
        }
    }
}
