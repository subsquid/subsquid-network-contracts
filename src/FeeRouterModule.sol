// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {FullMath} from "./libs/FullMath.sol";

/// @title Fee Router Module
/// @notice Manages fee distribution configuration between providers, worker pool, and burn
/// @dev uses basis points (BPS) for fee splits, must sum to 10000 (100%)
contract FeeRouterModule is AccessControl, IFeeRouter {
    uint256 public constant BASIS_POINTS = 10000;

    FeeConfig public feeConfig;

    /**
     * @dev initializes the fee router with default 50/50 split between providers and worker pool.
     */
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // 50/50 split: 50% to providers, 50% to worker pool
        feeConfig = FeeConfig({toProvidersBPS: 5000, toWorkerPoolBPS: 5000, toBurnBPS: 0});
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
            revert PortalErrors.InvalidFeeConfig();
        }

        uint256 dust = amount - used;
        if (dust > 0) {
            if (cfg.toProvidersBPS > cfg.toWorkerPoolBPS && cfg.toProvidersBPS > cfg.toBurnBPS) {
                toProviders += dust;
            } else if (cfg.toBurnBPS > cfg.toWorkerPoolBPS) {
                toBurn += dust;
            } else {
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
            revert PortalErrors.InvalidFeeConfig();
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
}
