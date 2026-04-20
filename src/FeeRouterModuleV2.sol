// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouterV2} from "./interfaces/IFeeRouterV2.sol";
import {IPancakeV3Router} from "./interfaces/IPancakeV3Router.sol";
import {IPancakeV3Pool} from "./interfaces/IPancakeV3Pool.sol";
import {IPancakeV3Factory} from "./interfaces/IPancakeV3Factory.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {FullMath} from "./libs/FullMath.sol";
import {TickMath} from "./libs/TickMath.sol";

/**
 * @title FeeRouterModuleV2
 * @dev 3-way fee split: providers / workers / burn.
 * providers get stablecoins (kept in pool).
 * workers + burn portions are swapped to SQD, then split proportionally.
 * e.g. (5000, 4500, 500) = 50% providers, 45% workers, 5% burn.
 */
contract FeeRouterModuleV2 is AccessControl, Pausable, ReentrancyGuard, IFeeRouterV2 {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;
    /// @notice Hard cap on admin-settable slippage. Bounds MEV damage if the admin key is compromised.
    uint16 public constant MAX_SLIPPAGE_BPS = 5000;
    /// @notice Minimum TWAP window. Prevents the oracle from degrading into a spot-price check.
    uint32 public constant MIN_TWAP_WINDOW = 600;

    FeeConfig public feeConfig;

    address public sqdBurnAddress;
    address public workerPoolAddress;
    IPancakeV3Router public pancakeRouter;
    IERC20 public sqd;
    address public weth;
    /// @notice PancakeSwap V3 fee tier for the first hop in reward-token buybacks (`rewardToken -> WETH`)
    /// @dev Reused for both swap execution and TWAP oracle pool lookup.
    uint24 public poolFee;
    /// @notice PancakeSwap V3 fee tier for the second hop in reward-token buybacks (`WETH -> SQD`)
    /// @dev Reused for both swap execution and TWAP oracle pool lookup.
    uint24 public poolFee2;
    bool public buybackEnabled;

    IPancakeV3Factory public pancakeFactory;
    uint32 public twapWindow;
    uint16 public maxSlippageBPS;

    mapping(address => bool) public allowedRewardTokens;

    constructor(address _pancakeRouter, address _pancakeFactory, address _sqd, address _weth) {
        if (_pancakeRouter == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == _weth) revert PoolErrors.InvalidTokenConfig();
        if (_pancakeFactory == address(0)) revert PoolErrors.InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        pancakeRouter = IPancakeV3Router(_pancakeRouter);
        sqd = IERC20(_sqd);
        pancakeFactory = IPancakeV3Factory(_pancakeFactory);
        weth = _weth;
        feeConfig = FeeConfig({toProvidersBPS: uint16(BASIS_POINTS), toWorkerPoolBPS: 0, toBurnBPS: 0});
        sqdBurnAddress = address(0xdead);
        poolFee = 2500;
        poolFee2 = 10000;
    }

    /**
     * @dev Calculates the provider leg and the combined protocol leg used by V2 routing.
     * @param amount total amount to split.
     * @return toProviders stablecoin amount kept for providers.
     * @return toWorkerPool always 0 (workers get sqd post-swap).
     * @return toProtocolSwap combined amount routed through the worker/burn buyback path.
     */
    function calculateSplit(uint256 amount)
        external
        view
        override
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toProtocolSwap)
    {
        toProviders = FullMath.mulDiv(amount, feeConfig.toProvidersBPS, BASIS_POINTS);
        toWorkerPool = 0;
        unchecked {
            toProtocolSwap = amount - toProviders;
        }
    }

    /**
     * @dev sets fee split. sum must equal 10000.
     * @param toProvidersBPS stablecoin % kept for providers.
     * @param toWorkerPoolBPS sqd % sent to worker pool (post-swap).
     * @param toBurnBPS sqd % burned (post-swap).
     */
    function setFeeConfig(uint16 toProvidersBPS, uint16 toWorkerPoolBPS, uint16 toBurnBPS)
        external
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (uint256(toProvidersBPS) + toWorkerPoolBPS + toBurnBPS != BASIS_POINTS) {
            revert PoolErrors.InvalidFeeConfig();
        }
        if (toWorkerPoolBPS > 0 && workerPoolAddress == address(0)) {
            revert PoolErrors.InvalidAddress();
        }

        feeConfig = FeeConfig({toProvidersBPS: toProvidersBPS, toWorkerPoolBPS: toWorkerPoolBPS, toBurnBPS: toBurnBPS});

        emit FeeConfigUpdated(toProvidersBPS, toWorkerPoolBPS, toBurnBPS);
    }

    /**
     * @dev returns current fee config.
     */
    function getFeeConfig() external view override returns (FeeConfig memory) {
        return feeConfig;
    }

    /**
     * @dev V2 routes the protocol leg to the router itself.
     * The router swaps reward tokens to SQD, then sends final burned SQD to `sqdBurnAddress`.
     */
    function getBurnAddress() external view override returns (address) {
        return address(this);
    }

    /**
     * @dev routes tokens from caller to worker pool. caller must approve first.
     * not called in normal flow (calculateSplit returns toWorkerPool=0).
     * restricted to whitelisted reward tokens for symmetry with routeToBurn and to avoid
     * polluting worker pool accounting with arbitrary ERC20s.
     * @param rewardToken token to route.
     * @param amount amount to route.
     */
    function routeToWorkerPool(address rewardToken, uint256 amount) external whenNotPaused {
        if (amount == 0) return;
        if (!allowedRewardTokens[rewardToken]) revert PoolErrors.TokenNotAllowed();
        address workerPool = workerPoolAddress;
        if (workerPool == address(0)) revert PoolErrors.InvalidAddress();
        IERC20(rewardToken).safeTransferFrom(msg.sender, workerPool, amount);
        emit RoutedToWorkerPool(msg.sender, rewardToken, amount);
    }

    /**
     * @dev routes tokens into an immediate buyback with TWAP slippage protection.
     * reverts if TWAP protection is not configured for non-SQD inputs.
     * @param rewardToken token to route.
     * @param amount amount to route.
     */
    function routeToBurn(address rewardToken, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) return;
        if (!allowedRewardTokens[rewardToken]) revert PoolErrors.TokenNotAllowed();

        uint256 received = _pullRewardTokenIn(rewardToken, amount);
        emit RoutedToBurn(msg.sender, rewardToken, received);
        _processBuyback(rewardToken, received);
    }

    function _pullRewardTokenIn(address rewardToken, uint256 amount) internal returns (uint256 received) {
        uint256 balanceBefore = IERC20(rewardToken).balanceOf(address(this));
        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(rewardToken).balanceOf(address(this)) - balanceBefore;
    }

    function _processBuyback(address rewardToken, uint256 amountIn) internal returns (uint256 sqdBought) {
        if (amountIn == 0) return 0;

        IERC20 sqdToken = sqd;
        address sqdTokenAddress = address(sqdToken);

        if (rewardToken == sqdTokenAddress) {
            sqdBought = amountIn;
            return _splitAndDistribute(rewardToken, amountIn, sqdBought, sqdToken);
        }

        IPancakeV3Router router = pancakeRouter;
        address routerAddress = address(router);
        address wethToken = weth;

        if (!buybackEnabled || routerAddress == address(0) || sqdTokenAddress == address(0) || wethToken == address(0))
        {
            revert PoolErrors.BuybackDisabled();
        }

        uint256 minSqdOut = resolveMinSqdOutFromTwap(rewardToken, amountIn, sqdTokenAddress, wethToken);

        IERC20(rewardToken).forceApprove(routerAddress, amountIn);
        sqdBought = _swapRewardTokenForSqd(router, rewardToken, amountIn, minSqdOut, sqdTokenAddress, wethToken);

        return _splitAndDistribute(rewardToken, amountIn, sqdBought, sqdToken);
    }

    /**
     * @dev swaps any current router balance to sqd and splits per config. callable by anyone.
     * intended for sweeping accidental direct transfers or legacy balances.
     * @param rewardToken token to swap.
     * @return sqdBought total sqd purchased.
     */
    function executeBuyback(address rewardToken) external whenNotPaused nonReentrant returns (uint256 sqdBought) {
        if (!allowedRewardTokens[rewardToken]) revert PoolErrors.TokenNotAllowed();
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) revert PoolErrors.NothingToBuyback();
        return _processBuyback(rewardToken, balance);
    }

    /**
     * @dev returns current router balance for a token.
     */
    function getPendingBuyback(address rewardToken) external view returns (uint256) {
        return IERC20(rewardToken).balanceOf(address(this));
    }

    /**
     * @dev returns buyback configuration.
     */
    function getBuybackConfig()
        external
        view
        returns (address router, address sqdToken, address wethToken, uint24 fee1, uint24 fee2, bool enabled)
    {
        return (address(pancakeRouter), address(sqd), weth, poolFee, poolFee2, buybackEnabled);
    }

    /**
     * @dev returns worker pool address.
     */
    function getWorkerPoolAddress() external view returns (address) {
        return workerPoolAddress;
    }

    /**
     * @notice Returns whether the TWAP-protected buyback path is ready for `rewardToken`.
     * @dev Off-chain tooling can call this before invoking a top-up to surface a precise reason
     *      when the oracle is not ready. Does not check pause state or router liveness.
     * @param rewardToken reward token the operator intends to route.
     * @return ok true when `routeToBurn(rewardToken, ...)` should succeed on the oracle path.
     * @return reason granular readiness code (see `ReadyReason`).
     */
    function isSlippageProtectionReady(address rewardToken) external view returns (bool ok, ReadyReason reason) {
        if (!allowedRewardTokens[rewardToken]) return (false, ReadyReason.TokenNotAllowed);

        address sqdAddr = address(sqd);
        if (rewardToken == sqdAddr) return (true, ReadyReason.Ready);

        address wethAddr = weth;
        if (!buybackEnabled || address(pancakeRouter) == address(0) || sqdAddr == address(0) || wethAddr == address(0))
        {
            return (false, ReadyReason.BuybackNotConfigured);
        }

        IPancakeV3Factory factory = pancakeFactory;
        uint32 window = twapWindow;
        if (address(factory) == address(0) || window == 0) {
            return (false, ReadyReason.SlippageNotConfigured);
        }

        (bool wethSqdOk, bool wethSqdExists) = _probeOraclePool(factory, wethAddr, sqdAddr, poolFee2, window);
        if (!wethSqdExists) return (false, ReadyReason.WethSqdPoolMissing);
        if (!wethSqdOk) return (false, ReadyReason.WethSqdPoolNotReady);

        if (rewardToken != wethAddr) {
            (bool rewardWethOk, bool rewardWethExists) =
                _probeOraclePool(factory, rewardToken, wethAddr, poolFee, window);
            if (!rewardWethExists) return (false, ReadyReason.RewardWethPoolMissing);
            if (!rewardWethOk) return (false, ReadyReason.RewardWethPoolNotReady);
        }

        return (true, ReadyReason.Ready);
    }

    /**
     * @dev configures buyback swap parameters.
     * @param _pancakeRouter pancakeswap v3 router address.
     * @param _sqd sqd token address.
     * @param _weth weth token address.
     * @param _poolFee fee tier for first hop (reward -> weth).
     * @param _poolFee2 fee tier for second hop (weth -> sqd).
     */
    function configureBuyback(address _pancakeRouter, address _sqd, address _weth, uint24 _poolFee, uint24 _poolFee2)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_pancakeRouter == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == _weth) revert PoolErrors.InvalidTokenConfig();
        _validatePoolFee(_poolFee);
        _validatePoolFee(_poolFee2);

        pancakeRouter = IPancakeV3Router(_pancakeRouter);
        sqd = IERC20(_sqd);
        weth = _weth;
        poolFee = _poolFee;
        poolFee2 = _poolFee2;

        emit BuybackConfigured(_pancakeRouter, _sqd, _weth, _poolFee, _poolFee2);
    }

    function setBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        buybackEnabled = enabled;
        emit BuybackEnabledChanged(enabled);
    }

    function setAllowedRewardToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (allowed && token == address(0)) revert PoolErrors.InvalidAddress();
        allowedRewardTokens[token] = allowed;
        emit RewardTokenAllowed(token, allowed);
    }

    function setPoolFee(uint24 _poolFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validatePoolFee(_poolFee);
        poolFee = _poolFee;
        emit PoolFeeChanged(_poolFee);
    }

    function setPoolFee2(uint24 _poolFee2) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validatePoolFee(_poolFee2);
        poolFee2 = _poolFee2;
        emit PoolFee2Changed(_poolFee2);
    }

    function setPancakeRouter(address _pancakeRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pancakeRouter == address(0)) revert PoolErrors.InvalidAddress();
        pancakeRouter = IPancakeV3Router(_pancakeRouter);
        emit PancakeRouterChanged(_pancakeRouter);
    }

    function setSqd(address _sqd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == weth) revert PoolErrors.InvalidTokenConfig();
        sqd = IERC20(_sqd);
        emit SqdChanged(_sqd);
    }

    function setPancakeFactory(address _pancakeFactory) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pancakeFactory == address(0)) revert PoolErrors.InvalidAddress();
        pancakeFactory = IPancakeV3Factory(_pancakeFactory);
        emit PancakeFactoryChanged(_pancakeFactory);
    }

    function setWeth(address _weth) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        if (_weth == address(sqd)) revert PoolErrors.InvalidTokenConfig();
        weth = _weth;
        emit WethChanged(_weth);
    }

    function setBurnAddress(address _newBurnAddress) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newBurnAddress == address(0)) revert PoolErrors.InvalidAddress();
        if (_newBurnAddress == address(this)) revert PoolErrors.InvalidAddress();
        sqdBurnAddress = _newBurnAddress;
        emit BurnAddressUpdated(_newBurnAddress);
    }

    function setWorkerPoolAddress(address _workerPoolAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        if (_workerPoolAddress == address(this)) revert PoolErrors.InvalidAddress();
        workerPoolAddress = _workerPoolAddress;
        emit WorkerPoolAddressUpdated(_workerPoolAddress);
    }

    /**
     * @dev Configures the TWAP oracle used by every non-SQD buyback path.
     * The oracle reuses the configured execution fee tiers (`poolFee` and `poolFee2`).
     *
     * @param _twapWindow observation window in seconds (e.g. 1800 = 30min).
     * @param _maxSlippageBPS max allowed slippage in bps (e.g. 300 = 3%).
     */
    function configureSlippageProtection(uint32 _twapWindow, uint16 _maxSlippageBPS)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_twapWindow < MIN_TWAP_WINDOW) revert PoolErrors.InvalidAmount();
        if (_maxSlippageBPS > MAX_SLIPPAGE_BPS) revert PoolErrors.InvalidFeeConfig();
        _validatePoolFee(poolFee);
        _validatePoolFee(poolFee2);

        twapWindow = _twapWindow;
        maxSlippageBPS = _maxSlippageBPS;

        emit SlippageProtectionConfigured(poolFee, poolFee2, _twapWindow, _maxSlippageBPS);
    }

    function setMaxSlippageBPS(uint16 _maxSlippageBPS) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxSlippageBPS > MAX_SLIPPAGE_BPS) revert PoolErrors.InvalidFeeConfig();
        uint16 oldValue = maxSlippageBPS;
        maxSlippageBPS = _maxSlippageBPS;
        emit MaxSlippageChanged(oldValue, _maxSlippageBPS);
    }

    function setTwapWindow(uint32 _twapWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_twapWindow < MIN_TWAP_WINDOW) revert PoolErrors.InvalidAmount();
        uint32 oldValue = twapWindow;
        twapWindow = _twapWindow;
        emit TwapWindowChanged(oldValue, _twapWindow);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev recovers tokens accidentally sent. cannot recover allowed reward tokens.
     * @param token token to recover.
     * @param to recipient address.
     * @param amount amount to recover.
     */
    function recoverTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert PoolErrors.InvalidAddress();
        if (allowedRewardTokens[token]) revert PoolErrors.TokenNotAllowed();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRecovered(token, to, amount, false);
    }

    /**
     * @dev emergency recovery path for allowed reward tokens that are stuck in the contract
     * (e.g. oracle/router misconfigured, buyback broken). requires paused state so
     * no buyback flow can run concurrently and users can't route more during recovery.
     * @param token allowed reward token to recover.
     * @param to recipient address.
     * @param amount amount to recover.
     */
    function emergencyRecoverRewardToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        if (to == address(0)) revert PoolErrors.InvalidAddress();
        if (!allowedRewardTokens[token]) revert PoolErrors.TokenNotAllowed();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRecovered(token, to, amount, true);
    }

    /**
     * @dev splits sqd between worker pool and burn per feeConfig ratio.
     */
    function _splitAndDistribute(address rewardToken, uint256 amountIn, uint256 sqdAmount, IERC20 sqdToken)
        internal
        returns (uint256)
    {
        FeeConfig memory cfg = feeConfig;
        uint256 protocolBPS;
        unchecked {
            protocolBPS = uint256(cfg.toWorkerPoolBPS) + cfg.toBurnBPS;
        }

        uint256 toWorkerPool;
        uint256 toBurn;

        if (protocolBPS > 0) {
            toWorkerPool = FullMath.mulDiv(sqdAmount, cfg.toWorkerPoolBPS, protocolBPS);
            unchecked {
                toBurn = sqdAmount - toWorkerPool;
            }
        } else {
            toBurn = sqdAmount;
        }

        address workerPool = workerPoolAddress;
        if (toWorkerPool > 0) {
            if (workerPool == address(0)) revert PoolErrors.InvalidAddress();
            sqdToken.safeTransfer(workerPool, toWorkerPool);
        }
        if (toBurn > 0) {
            sqdToken.safeTransfer(sqdBurnAddress, toBurn);
        }

        emit BuybackExecuted(rewardToken, amountIn, sqdAmount, toWorkerPool, toBurn);
        return sqdAmount;
    }

    /**
     * @dev Resolves a TWAP-based minimum SQD output for `rewardToken -> WETH -> SQD`.
     * The two hop ticks are added after normalization, then reduced by `maxSlippageBPS`.
     */
    function resolveMinSqdOutFromTwap(address rewardToken, uint256 amountIn, address sqdTokenAddress, address wethToken)
        public
        view
        returns (uint256)
    {
        IPancakeV3Factory factory = pancakeFactory;
        uint32 window = twapWindow;
        if (address(factory) == address(0) || window == 0) {
            revert PoolErrors.SlippageProtectionNotConfigured();
        }
        uint24 fee1 = poolFee;
        uint24 fee2 = poolFee2;
        uint16 slippage = maxSlippageBPS;

        int24 combinedTick;
        if (rewardToken == wethToken) {
            combinedTick = _getTwapTick(factory, window, wethToken, sqdTokenAddress, fee2);
        } else {
            int24 tick1 = _getTwapTick(factory, window, rewardToken, wethToken, fee1);
            int24 tick2 = _getTwapTick(factory, window, wethToken, sqdTokenAddress, fee2);
            unchecked {
                combinedTick = tick1 + tick2;
            }
        }

        uint256 expectedOut = _getAmountFromTick(amountIn, combinedTick);
        return FullMath.mulDiv(expectedOut, BASIS_POINTS - slippage, BASIS_POINTS);
    }

    /**
     * @dev reads twap tick from a pancakeswap v3 pool over the configured window.
     */
    function _getTwapTick(IPancakeV3Factory factory, uint32 window, address tokenA, address tokenB, uint24 fee)
        internal
        view
        returns (int24)
    {
        address pool = factory.getPool(tokenA, tokenB, fee);
        if (pool == address(0)) revert PoolErrors.InvalidPool();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = IPancakeV3Pool(pool).observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 timeDelta = int56(uint56(window));
        int24 twapTick = int24(tickDelta / timeDelta);
        if (tickDelta < 0 && (tickDelta % timeDelta != 0)) {
            --twapTick;
        }

        if (tokenA > tokenB) {
            twapTick = -twapTick;
        }

        return twapTick;
    }

    /**
     * @dev Probes a single oracle pool for existence and ability to serve a TWAP over `window`.
     * @return ok true when `observe([window, 0])` would succeed against this pool.
     * @return exists false when the factory has no pool for this (tokenA, tokenB, fee) tuple.
     */
    function _probeOraclePool(IPancakeV3Factory factory, address tokenA, address tokenB, uint24 fee, uint32 window)
        internal
        view
        returns (bool ok, bool exists)
    {
        address pool = factory.getPool(tokenA, tokenB, fee);
        if (pool == address(0)) return (false, false);
        exists = true;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        try IPancakeV3Pool(pool).observe(secondsAgos) returns (int56[] memory, uint160[] memory) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /**
     * @dev converts a tick to an expected output amount using TickMath.
     * price = (sqrtPrice / 2^96)^2, so amountOut = amountIn * price.
     * V3 ticks already encode the raw-unit price ratio, so no extra decimals normalization is needed.
     * @param amountIn input amount (raw units of input token).
     * @param tick combined twap tick (sign-normalized for input -> output direction).
     * @return expected output amount (raw units of output token).
     */
    function _getAmountFromTick(uint256 amountIn, int24 tick) internal pure returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);

        // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
        // amountOut = amountIn * price = amountIn * sqrtPriceX96^2 / 2^192
        if (sqrtPriceX96 < (1 << 128)) {
            uint256 priceX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return FullMath.mulDiv(amountIn, priceX192, 1 << 192);
        } else {
            uint256 priceX128 = FullMath.mulDiv(uint256(sqrtPriceX96), sqrtPriceX96, 1 << 64);
            return FullMath.mulDiv(amountIn, priceX128, 1 << 128);
        }
    }

    function _validatePoolFee(uint24 fee) internal pure {
        if (fee != 100 && fee != 500 && fee != 2500 && fee != 10000) {
            revert PoolErrors.InvalidPoolFee();
        }
    }

    function _swapRewardTokenForSqd(
        IPancakeV3Router router,
        address rewardToken,
        uint256 amountIn,
        uint256 minSqdOut,
        address sqdTokenAddress,
        address wethToken
    ) internal returns (uint256 sqdBought) {
        if (rewardToken == wethToken) {
            uint24 fee = poolFee2;

            return router.exactInputSingle(
                IPancakeV3Router.ExactInputSingleParams({
                    tokenIn: rewardToken,
                    tokenOut: sqdTokenAddress,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: minSqdOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        return router.exactInput(
            IPancakeV3Router.ExactInputParams({
                path: abi.encodePacked(rewardToken, poolFee, wethToken, poolFee2, sqdTokenAddress),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minSqdOut
            })
        );
    }
}
