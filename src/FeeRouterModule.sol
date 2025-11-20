// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";

contract FeeRouterModule is AccessControl, IFeeRouter {

    uint256 public constant BASIS_POINTS = 10000;

    FeeConfig public feeConfig;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // 50/50 split: 50% to providers, 50% to worker pool
        feeConfig = FeeConfig({
            toProvidersBPS: 5000,
            toWorkerPoolBPS: 5000,
            toBurnBPS: 0
        });
    }
    
    function calculateSplit(uint256 amount) external view returns (
        uint256 toProviders,
        uint256 toWorkerPool,
        uint256 toBurn
    ) {
        // M-11: Calculate first two portions, then assign remainder to toBurn
        // This ensures sum always equals amount (no rounding loss)
        toProviders = (amount * feeConfig.toProvidersBPS) / BASIS_POINTS;
        toWorkerPool = (amount * feeConfig.toWorkerPoolBPS) / BASIS_POINTS;
        toBurn = amount - toProviders - toWorkerPool;
    }
    
    function setFeeConfig(
        uint16 toProvidersBPS,
        uint16 toWorkerPoolBPS,
        uint16 toBurnBPS
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            toProvidersBPS + toWorkerPoolBPS + toBurnBPS == BASIS_POINTS,
            "Must sum to 100%"
        );
        
        feeConfig = FeeConfig({
            toProvidersBPS: toProvidersBPS,
            toWorkerPoolBPS: toWorkerPoolBPS,
            toBurnBPS: toBurnBPS
        });
        
        emit FeeConfigUpdated(toProvidersBPS, toWorkerPoolBPS, toBurnBPS);
    }
    
    function getFeeConfig() external view returns (FeeConfig memory) {
        return feeConfig;
    }
}
