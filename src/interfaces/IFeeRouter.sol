// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFeeRouter {
    struct FeeConfig {
        uint16 toProvidersBPS;
        uint16 toWorkerPoolBPS;
        uint16 toBurnBPS;
    }

    event FeeConfigUpdated(uint16 toProviders, uint16 toWorkerPool, uint16 toBurn);

    function calculateSplit(uint256 amount)
        external
        view
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn);

    function setFeeConfig(uint16 toProvidersBPS, uint16 toWorkerPoolBPS, uint16 toBurnBPS) external;

    function getFeeConfig() external view returns (FeeConfig memory);
}
