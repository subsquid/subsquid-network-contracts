// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IFeeRouterV2
/// @notice Fee router interface with buyback and TWAP slippage controls
interface IFeeRouterV2 {
    struct FeeConfig {
        uint16 toProvidersBPS;
        uint16 toWorkerPoolBPS;
        uint16 toBurnBPS;
    }

    /// @notice Granular readiness codes returned by `isSlippageProtectionReady`.
    enum ReadyReason {
        Ready,
        TokenNotAllowed,
        BuybackNotConfigured,
        SlippageNotConfigured,
        WethSqdPoolMissing,
        RewardWethPoolMissing,
        WethSqdPoolNotReady,
        RewardWethPoolNotReady
    }

    event FeeConfigUpdated(uint16 toProviders, uint16 toWorkerPool, uint16 toBurn);
    event BurnAddressUpdated(address burnAddress);
    event WorkerPoolAddressUpdated(address workerPoolAddress);
    event RoutedToWorkerPool(address indexed from, address indexed rewardToken, uint256 amount);
    event RoutedToBurn(address indexed from, address indexed rewardToken, uint256 amount);
    event BuybackExecuted(
        address indexed rewardToken, uint256 amountIn, uint256 sqdBought, uint256 toWorkerPool, uint256 toBurn
    );
    event BuybackConfigured(address router, address sqd, address weth, uint24 fee1, uint24 fee2);
    event BuybackEnabledChanged(bool enabled);
    event PoolFeeChanged(uint24 fee);
    event PoolFee2Changed(uint24 fee);
    event WethChanged(address weth);
    event RewardTokenAllowed(address indexed token, bool allowed);
    event SlippageProtectionConfigured(address factory, uint24 fee1, uint24 fee2, uint32 window, uint16 slippage);
    event MaxSlippageChanged(uint16 oldValue, uint16 newValue);
    event TwapWindowChanged(uint32 oldValue, uint32 newValue);
    event TokensRecovered(address indexed token, address indexed to, uint256 amount, bool emergency);

    function calculateSplit(uint256 amount)
        external
        view
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn);

    function setFeeConfig(uint16 toProvidersBPS, uint16 toWorkerPoolBPS, uint16 toBurnBPS) external;

    function getFeeConfig() external view returns (FeeConfig memory);

    function setBurnAddress(address newBurnAddress) external;

    function getBurnAddress() external view returns (address);

    function setWorkerPoolAddress(address workerPool) external;

    function getWorkerPoolAddress() external view returns (address);

    function routeToWorkerPool(address rewardToken, uint256 amount) external;

    function routeToBurn(address rewardToken, uint256 amount) external;

    function executeBuyback(address rewardToken) external returns (uint256 sqdBought);

    function getPendingBuyback(address rewardToken) external view returns (uint256);

    function getBuybackConfig()
        external
        view
        returns (address router, address sqdToken, address wethToken, uint24 fee1, uint24 fee2, bool enabled);

    function configureBuyback(address pancakeRouter, address sqd, address weth, uint24 poolFee, uint24 poolFee2)
        external;

    function setBuybackEnabled(bool enabled) external;

    function setAllowedRewardToken(address token, bool allowed) external;

    function setPoolFee(uint24 poolFee) external;

    function setPoolFee2(uint24 poolFee2) external;

    function setWeth(address weth) external;

    function configureSlippageProtection(address pancakeFactory, uint32 twapWindow, uint16 maxSlippageBPS) external;

    function setMaxSlippageBPS(uint16 maxSlippageBPS) external;

    function setTwapWindow(uint32 twapWindow) external;

    function isSlippageProtectionReady(address rewardToken) external view returns (bool ok, ReadyReason reason);

    function recoverTokens(address token, address to, uint256 amount) external;

    function pause() external;

    function unpause() external;
}
