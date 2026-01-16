// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {FullMath} from "./libs/FullMath.sol";

/// @title Fee Router Module
/// @notice Manages fee distribution configuration between providers, worker pool, and burn
/// @dev uses basis points (BPS) for fee splits, must sum to 10000 (100%)
contract FeeRouterModule is AccessControl, IFeeRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10000;

    FeeConfig public feeConfig;
    address public burnAddress;
    address public workerPoolAddress;

    /**
     * @dev initializes the fee router with default 50/50 split between providers and worker pool.
     */
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // 100% to providers, 0% to worker pool, 0% to burn
        feeConfig = FeeConfig({toProvidersBPS: 10000, toWorkerPoolBPS: 0, toBurnBPS: 0});
        burnAddress = address(0xdead);
    }

    /**
     * @dev calculates the fee split for a given amount.
     * @notice Computes how an amount should be distributed based on current fee config.
     * @param amount the total amount to split.
     * @return toProviders amount allocated to providers.
     * @return toWorkerPool amount allocated to worker pool.
     * @return toBurn amount allocated for burning.
     */
    function calculateSplit(uint256 amount)
        external
        view
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn)
    {
        FeeConfig memory cfg = feeConfig;

        toProviders = FullMath.mulDiv(amount, cfg.toProvidersBPS, BASIS_POINTS);
        toWorkerPool = FullMath.mulDiv(amount, cfg.toWorkerPoolBPS, BASIS_POINTS);
        toBurn = FullMath.mulDiv(amount, cfg.toBurnBPS, BASIS_POINTS);

        uint256 used = toProviders + toWorkerPool + toBurn;
        if (used > amount) {
            revert PoolErrors.InvalidFeeConfig();
        }

        uint256 dust = amount - used;
        if (dust > 0) {
            // On equal BPS, worker pool wins (protocol preference)
            if (cfg.toProvidersBPS > cfg.toWorkerPoolBPS && cfg.toProvidersBPS > cfg.toBurnBPS) {
                toProviders += dust;
            } else if (cfg.toBurnBPS > cfg.toWorkerPoolBPS) {
                toBurn += dust;
            } else {
                // Worker pool wins ties (protocol benefits)
                toWorkerPool += dust;
            }
        }
    }

    /**
     * @dev sets the fee distribution configuration.
     * @notice Updates how fees are split. Sum of all BPS values must equal 10000.
     * @param toProvidersBPS basis points allocated to providers.
     * @param toWorkerPoolBPS basis points allocated to worker pool.
     * @param toBurnBPS basis points allocated for burning.
     */
    function setFeeConfig(uint16 toProvidersBPS, uint16 toWorkerPoolBPS, uint16 toBurnBPS)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (toProvidersBPS + toWorkerPoolBPS + toBurnBPS != BASIS_POINTS) {
            revert PoolErrors.InvalidFeeConfig();
        }
        if (toWorkerPoolBPS > 0 && workerPoolAddress == address(0)) {
            revert PoolErrors.InvalidAddress();
        }
        if (toBurnBPS > 0 && burnAddress == address(0)) {
            revert PoolErrors.InvalidAddress();
        }

        feeConfig = FeeConfig({toProvidersBPS: toProvidersBPS, toWorkerPoolBPS: toWorkerPoolBPS, toBurnBPS: toBurnBPS});

        emit FeeConfigUpdated(toProvidersBPS, toWorkerPoolBPS, toBurnBPS);
    }

    /**
     * @dev returns the current fee configuration.
     */
    function getFeeConfig() external view returns (FeeConfig memory) {
        return feeConfig;
    }

    /**
     * @dev sets the burn address where burned tokens are sent.
     * @param newBurnAddress the new burn address.
     */
    function setBurnAddress(address newBurnAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBurnAddress == address(0)) revert PoolErrors.InvalidAddress();
        burnAddress = newBurnAddress;
        emit BurnAddressUpdated(newBurnAddress);
    }

    /**
     * @dev returns the current burn address.
     */
    function getBurnAddress() external view returns (address) {
        return burnAddress;
    }

    /**
     * @dev sets the worker pool address.
     * @param _workerPoolAddress the new worker pool address.
     */
    function setWorkerPoolAddress(address _workerPoolAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        workerPoolAddress = _workerPoolAddress;
        emit WorkerPoolAddressUpdated(_workerPoolAddress);
    }

    /**
     * @dev returns the current worker pool address.
     */
    function getWorkerPoolAddress() external view returns (address) {
        return workerPoolAddress;
    }

    /**
     * @dev routes tokens from caller to worker pool.
     * @notice Caller must approve this contract first.
     * @param rewardToken the token to route.
     * @param amount the amount to route.
     */
    function routeToWorkerPool(address rewardToken, uint256 amount) external {
        if (amount == 0) return;
        if (workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        IERC20(rewardToken).safeTransferFrom(msg.sender, workerPoolAddress, amount);
        emit RoutedToWorkerPool(msg.sender, rewardToken, amount);
    }

    /**
     * @dev routes tokens from caller to burn address.
     * @notice Caller must approve this contract first.
     * @param rewardToken the token to route.
     * @param amount the amount to route.
     */
    function routeToBurn(address rewardToken, uint256 amount) external {
        if (amount == 0) return;
        IERC20(rewardToken).safeTransferFrom(msg.sender, burnAddress, amount);
        emit RoutedToBurn(msg.sender, rewardToken, amount);
    }
}
