// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {IFeeRouter} from "../src/interfaces/IFeeRouter.sol";

contract FeeRouterModuleTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    function test_Constructor_SetsDefaultFeeConfig() public view {
        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();

        assertEq(config.toProvidersBPS, 5000);
        assertEq(config.toWorkerPoolBPS, 5000);
        assertEq(config.toBurnBPS, 0);
    }

    function test_Constructor_GrantsAdminRole() public view {
        assertTrue(feeRouter.hasRole(feeRouter.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_CalculateSplit_DefaultConfig() public view {
        uint256 amount = 1000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 500 ether);
        assertEq(toWorkerPool, 500 ether);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_CustomConfig() public {
        feeRouter.setFeeConfig(3000, 5000, 2000);

        uint256 amount = 1000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 300 ether);
        assertEq(toWorkerPool, 500 ether);
        assertEq(toBurn, 200 ether);
    }

    function test_CalculateSplit_ZeroAmount() public view {
        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(0);

        assertEq(toProviders, 0);
        assertEq(toWorkerPool, 0);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_SmallAmounts() public view {
        uint256 amount = 100;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 50);
        assertEq(toWorkerPool, 50);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_LargeAmounts() public view {
        uint256 amount = 10_000_000_000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 5_000_000_000 ether);
        assertEq(toWorkerPool, 5_000_000_000 ether);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_OddAmount() public view {
        uint256 amount = 1001;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        // On equal BPS (50/50), worker pool wins tie for dust: 500 + 1 dust = 501
        assertEq(toProviders, 500);
        assertEq(toWorkerPool, 501);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_AllToProviders() public {
        feeRouter.setFeeConfig(10000, 0, 0);

        uint256 amount = 1000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 1000 ether);
        assertEq(toWorkerPool, 0);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_AllToWorkerPool() public {
        feeRouter.setFeeConfig(0, 10000, 0);

        uint256 amount = 1000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 0);
        assertEq(toWorkerPool, 1000 ether);
        assertEq(toBurn, 0);
    }

    function test_CalculateSplit_AllToBurn() public {
        feeRouter.setFeeConfig(0, 0, 10000);

        uint256 amount = 1000 ether;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders, 0);
        assertEq(toWorkerPool, 0);
        assertEq(toBurn, 1000 ether);
    }

    function test_SetFeeConfig_Success() public {
        vm.expectEmit(true, true, true, false);
        emit IFeeRouter.FeeConfigUpdated(3000, 5000, 2000);

        feeRouter.setFeeConfig(3000, 5000, 2000);

        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();
        assertEq(config.toProvidersBPS, 3000);
        assertEq(config.toWorkerPoolBPS, 5000);
        assertEq(config.toBurnBPS, 2000);
    }

    function test_SetFeeConfig_RevertOnInvalidTotal() public {
        vm.expectRevert(PortalErrors.InvalidFeeConfig.selector);
        feeRouter.setFeeConfig(3000, 5000, 1000);
    }

    function test_SetFeeConfig_RevertOnOverflow() public {
        vm.expectRevert(PortalErrors.InvalidFeeConfig.selector);
        feeRouter.setFeeConfig(5000, 5000, 1);
    }

    function test_SetFeeConfig_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        feeRouter.setFeeConfig(3000, 5000, 2000);
    }

    function test_SetFeeConfig_ZeroProviders() public {
        feeRouter.setFeeConfig(0, 8000, 2000);

        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();
        assertEq(config.toProvidersBPS, 0);
        assertEq(config.toWorkerPoolBPS, 8000);
        assertEq(config.toBurnBPS, 2000);
    }

    function test_SetFeeConfig_ZeroWorkerPool() public {
        feeRouter.setFeeConfig(8000, 0, 2000);

        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();
        assertEq(config.toProvidersBPS, 8000);
        assertEq(config.toWorkerPoolBPS, 0);
        assertEq(config.toBurnBPS, 2000);
    }

    function test_SetFeeConfig_ZeroBurn() public {
        feeRouter.setFeeConfig(6000, 4000, 0);

        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();
        assertEq(config.toProvidersBPS, 6000);
        assertEq(config.toWorkerPoolBPS, 4000);
        assertEq(config.toBurnBPS, 0);
    }

    function testFuzz_CalculateSplit_TotalEqualsInput(uint256 amount) public view {
        vm.assume(amount < type(uint256).max / 10000);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(amount);

        assertEq(toProviders + toWorkerPool + toBurn, amount);
    }

    function testFuzz_SetFeeConfig_ValidConfigs(uint16 providers, uint16 workers) public {
        vm.assume(providers <= 10000);
        vm.assume(workers <= 10000 - providers);

        uint16 burn = uint16(10000 - providers - workers);

        feeRouter.setFeeConfig(providers, workers, burn);

        IFeeRouter.FeeConfig memory config = feeRouter.getFeeConfig();
        assertEq(config.toProvidersBPS, providers);
        assertEq(config.toWorkerPoolBPS, workers);
        assertEq(config.toBurnBPS, burn);
    }
}
