// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
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
contract FeeRouterModuleV2 is AccessControl, Pausable, ReentrancyGuard, IFeeRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;
    uint8 public constant SKIP_DISABLED = 0;
    uint8 public constant SKIP_BELOW_THRESHOLD = 1;

    FeeConfig public feeConfig;

    address public sqdBurnAddress;
    address public workerPoolAddress;
    IPancakeV3Router public pancakeRouter;
    IERC20 public sqd;
    address public weth;
    uint24 public poolFee;
    uint24 public poolFee2;
    uint256 public minBuybackThreshold;
    bool public buybackEnabled;
    bool public autoBuybackEnabled;

    IPancakeV3Factory public pancakeFactory;
    uint24 public oraclePoolFee;
    uint24 public oraclePoolFee2;
    uint32 public twapWindow;
    uint16 public maxSlippageBPS;

    mapping(address => bool) public allowedRewardTokens;
    mapping(address => uint256) public accumulatedForBuyback;
    address[] public accumulatedTokens;
    mapping(address => bool) private _isAccumulatedToken;

    event BuybackExecuted(
        address indexed rewardToken, uint256 amountIn, uint256 sqdBought, uint256 toWorkerPool, uint256 toBurn
    );
    event BuybackSkipped(uint256 amount, uint8 reason);
    event BuybackConfigured(address router, address sqd, address weth, uint24 fee1, uint24 fee2, uint256 minThreshold);
    event BuybackEnabledChanged(bool enabled);
    event AutoBuybackEnabledChanged(bool enabled);
    event PoolFeeChanged(uint24 fee);
    event PoolFee2Changed(uint24 fee);
    event WethChanged(address weth);
    event MinBuybackThresholdChanged(uint256 threshold);
    event RewardTokenAllowed(address indexed token, bool allowed);
    event TokensAccumulated(address indexed rewardToken, uint256 amount, uint256 totalAccumulated);
    event SlippageProtectionConfigured(
        address factory, uint24 oracleFee1, uint24 oracleFee2, uint32 window, uint16 slippage
    );
    event MaxSlippageChanged(uint16 oldValue, uint16 newValue);
    event TwapWindowChanged(uint32 oldValue, uint32 newValue);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        feeConfig = FeeConfig({toProvidersBPS: 5000, toWorkerPoolBPS: 4500, toBurnBPS: 500});
        sqdBurnAddress = address(0xdead);
        poolFee = 2500;
    }

    /**
     * @dev calculates fee split. workers+burn are combined into toBurn for routing.
     * @param amount total amount to split.
     * @return toProviders stablecoin amount kept for providers.
     * @return toWorkerPool always 0 (workers get sqd post-swap).
     * @return toBurn combined amount to swap to sqd.
     */
    function calculateSplit(uint256 amount)
        external
        view
        override
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn)
    {
        toProviders = FullMath.mulDiv(amount, feeConfig.toProvidersBPS, BASIS_POINTS);
        toWorkerPool = 0;
        toBurn = amount - toProviders;
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
     * @dev returns this contract's address. tokens accumulate here for buyback.
     */
    function getBurnAddress() external view override returns (address) {
        return address(this);
    }

    /**
     * @dev routes tokens from caller to worker pool. caller must approve first.
     * kept for IFeeRouter compat. not called in normal flow (calculateSplit returns toWorkerPool=0).
     * @param rewardToken token to route.
     * @param amount amount to route.
     */
    function routeToWorkerPool(address rewardToken, uint256 amount) external whenNotPaused {
        if (amount == 0) return;
        if (workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        IERC20(rewardToken).safeTransferFrom(msg.sender, workerPoolAddress, amount);
        emit RoutedToWorkerPool(msg.sender, rewardToken, amount);
    }

    /**
     * @dev accumulates tokens for buyback. may trigger auto-buyback if enabled and above threshold.
     * @param rewardToken token to accumulate.
     * @param amount amount to accumulate.
     */
    function routeToBurn(address rewardToken, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) return;
        if (!allowedRewardTokens[rewardToken]) revert PoolErrors.TokenNotAllowed();

        uint256 balanceBefore = IERC20(rewardToken).balanceOf(address(this));
        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(rewardToken).balanceOf(address(this)) - balanceBefore;

        accumulatedForBuyback[rewardToken] += received;

        if (!_isAccumulatedToken[rewardToken]) {
            accumulatedTokens.push(rewardToken);
            _isAccumulatedToken[rewardToken] = true;
        }

        emit RoutedToBurn(msg.sender, rewardToken, received);
        emit TokensAccumulated(rewardToken, received, accumulatedForBuyback[rewardToken]);

        if (autoBuybackEnabled && accumulatedForBuyback[rewardToken] >= minBuybackThreshold) {
            _executeBuybackInternal(rewardToken, 0);
        }
    }

    /**
     * @dev swaps accumulated tokens to sqd and splits per config. callable by anyone.
     * @param rewardToken token to swap.
     * @param minSqdOut minimum sqd out (slippage protection).
     * @return sqdBought total sqd purchased.
     */
    function executeBuyback(address rewardToken, uint256 minSqdOut)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 sqdBought)
    {
        if (!allowedRewardTokens[rewardToken]) revert PoolErrors.TokenNotAllowed();
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) revert PoolErrors.NothingToBuyback();
        return _executeBuybackInternal(rewardToken, minSqdOut);
    }

    /**
     * @dev returns pending buyback balance for a token.
     */
    function getPendingBuyback(address rewardToken) external view returns (uint256) {
        return IERC20(rewardToken).balanceOf(address(this));
    }

    /**
     * @dev returns all accumulated tokens and their balances.
     */
    function getAccumulatedTokens() external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 len = accumulatedTokens.length;
        tokens = new address[](len);
        amounts = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            tokens[i] = accumulatedTokens[i];
            amounts[i] = IERC20(accumulatedTokens[i]).balanceOf(address(this));
        }
    }

    /**
     * @dev returns buyback configuration.
     */
    function getBuybackConfig()
        external
        view
        returns (
            address router,
            address sqdToken,
            address wethToken,
            uint24 fee1,
            uint24 fee2,
            uint256 minThreshold,
            bool enabled
        )
    {
        return (address(pancakeRouter), address(sqd), weth, poolFee, poolFee2, minBuybackThreshold, buybackEnabled);
    }

    /**
     * @dev returns worker pool address.
     */
    function getWorkerPoolAddress() external view returns (address) {
        return workerPoolAddress;
    }

    /**
     * @dev configures buyback swap parameters.
     * @param _pancakeRouter pancakeswap v3 router address.
     * @param _sqd sqd token address.
     * @param _weth weth token address.
     * @param _poolFee fee tier for first hop (reward -> weth).
     * @param _poolFee2 fee tier for second hop (weth -> sqd).
     * @param _minBuybackThreshold minimum balance to trigger buyback.
     */
    function configureBuyback(
        address _pancakeRouter,
        address _sqd,
        address _weth,
        uint24 _poolFee,
        uint24 _poolFee2,
        uint256 _minBuybackThreshold
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pancakeRouter == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        _validatePoolFee(_poolFee);
        _validatePoolFee(_poolFee2);

        pancakeRouter = IPancakeV3Router(_pancakeRouter);
        sqd = IERC20(_sqd);
        weth = _weth;
        poolFee = _poolFee;
        poolFee2 = _poolFee2;
        minBuybackThreshold = _minBuybackThreshold;

        emit BuybackConfigured(_pancakeRouter, _sqd, _weth, _poolFee, _poolFee2, _minBuybackThreshold);
    }

    function setBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        buybackEnabled = enabled;
        emit BuybackEnabledChanged(enabled);
    }

    function setAutoBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        autoBuybackEnabled = enabled;
        emit AutoBuybackEnabledChanged(enabled);
    }

    function setAllowedRewardToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
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

    function setWeth(address _weth) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        weth = _weth;
        emit WethChanged(_weth);
    }

    function setMinBuybackThreshold(uint256 _minBuybackThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBuybackThreshold = _minBuybackThreshold;
        emit MinBuybackThresholdChanged(_minBuybackThreshold);
    }

    function setBurnAddress(address newBurnAddress) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBurnAddress == address(0)) revert PoolErrors.InvalidAddress();
        sqdBurnAddress = newBurnAddress;
        emit BurnAddressUpdated(newBurnAddress);
    }

    function setWorkerPoolAddress(address _workerPoolAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        workerPoolAddress = _workerPoolAddress;
        emit WorkerPoolAddressUpdated(_workerPoolAddress);
    }

    /**
     * @dev configures twap oracle for auto-buyback slippage protection.
     * @param _pancakeFactory pancakeswap v3 factory for pool lookup.
     * @param _oraclePoolFee fee tier for rewardToken/weth oracle pool.
     * @param _oraclePoolFee2 fee tier for weth/sqd oracle pool.
     * @param _twapWindow observation window in seconds (e.g. 1800 = 30min).
     * @param _maxSlippageBPS max allowed slippage in bps (e.g. 300 = 3%).
     */
    function configureSlippageProtection(
        address _pancakeFactory,
        uint24 _oraclePoolFee,
        uint24 _oraclePoolFee2,
        uint32 _twapWindow,
        uint16 _maxSlippageBPS
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pancakeFactory == address(0)) revert PoolErrors.InvalidAddress();
        if (_twapWindow == 0) revert PoolErrors.InvalidAmount();
        if (_maxSlippageBPS > uint16(BASIS_POINTS)) revert PoolErrors.InvalidFeeConfig();

        pancakeFactory = IPancakeV3Factory(_pancakeFactory);
        oraclePoolFee = _oraclePoolFee;
        oraclePoolFee2 = _oraclePoolFee2;
        twapWindow = _twapWindow;
        maxSlippageBPS = _maxSlippageBPS;

        emit SlippageProtectionConfigured(
            _pancakeFactory, _oraclePoolFee, _oraclePoolFee2, _twapWindow, _maxSlippageBPS
        );
    }

    function setMaxSlippageBPS(uint16 _maxSlippageBPS) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxSlippageBPS > uint16(BASIS_POINTS)) revert PoolErrors.InvalidFeeConfig();
        uint16 oldValue = maxSlippageBPS;
        maxSlippageBPS = _maxSlippageBPS;
        emit MaxSlippageChanged(oldValue, _maxSlippageBPS);
    }

    function setTwapWindow(uint32 _twapWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_twapWindow == 0) revert PoolErrors.InvalidAmount();
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
    }

    /**
     * @dev swaps accumulated reward tokens to sqd via pancakeswap v3 multi-hop.
     * splits purchased sqd proportionally between worker pool and burn per feeConfig.
     * falls back to direct transfer if buyback is disabled or not configured.
     * @param rewardToken token to swap.
     * @param minSqdOut minimum sqd output (slippage protection).
     * @return sqdBought total sqd purchased.
     */
    function _executeBuybackInternal(address rewardToken, uint256 minSqdOut) internal returns (uint256 sqdBought) {
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) return 0;

        accumulatedForBuyback[rewardToken] = 0;

        // if reward token is already sqd, skip swap — just split directly
        if (rewardToken == address(sqd)) {
            sqdBought = balance;
            return _splitAndDistribute(rewardToken, balance, sqdBought);
        }

        if (!buybackEnabled || address(pancakeRouter) == address(0) || address(sqd) == address(0) || weth == address(0))
        {
            IERC20(rewardToken).safeTransfer(sqdBurnAddress, balance);
            emit BuybackSkipped(balance, SKIP_DISABLED);
            return 0;
        }

        if (balance < minBuybackThreshold) {
            accumulatedForBuyback[rewardToken] = balance;
            emit BuybackSkipped(balance, SKIP_BELOW_THRESHOLD);
            return 0;
        }

        // if caller didn't specify minSqdOut, compute from twap oracle
        if (minSqdOut == 0 && maxSlippageBPS > 0 && address(pancakeFactory) != address(0) && twapWindow > 0) {
            minSqdOut = _computeTwapMinOut(rewardToken, balance);
        }

        IERC20(rewardToken).forceApprove(address(pancakeRouter), balance);

        sqdBought = pancakeRouter.exactInput(
            IPancakeV3Router.ExactInputParams({
                path: abi.encodePacked(rewardToken, poolFee, weth, poolFee2, address(sqd)),
                recipient: address(this),
                amountIn: balance,
                amountOutMinimum: minSqdOut
            })
        );

        return _splitAndDistribute(rewardToken, balance, sqdBought);
    }

    /**
     * @dev splits sqd between worker pool and burn per feeConfig ratio.
     */
    function _splitAndDistribute(address rewardToken, uint256 amountIn, uint256 sqdAmount) internal returns (uint256) {
        FeeConfig memory cfg = feeConfig;
        uint256 protocolBPS = uint256(cfg.toWorkerPoolBPS) + cfg.toBurnBPS;

        uint256 toWorkerPool;
        uint256 toBurn;

        if (protocolBPS > 0) {
            toWorkerPool = FullMath.mulDiv(sqdAmount, cfg.toWorkerPoolBPS, protocolBPS);
            toBurn = sqdAmount - toWorkerPool;
        } else {
            toBurn = sqdAmount;
        }

        if (toWorkerPool > 0 && workerPoolAddress != address(0)) {
            sqd.safeTransfer(workerPoolAddress, toWorkerPool);
        }
        if (toBurn > 0) {
            sqd.safeTransfer(sqdBurnAddress, toBurn);
        }

        emit BuybackExecuted(rewardToken, amountIn, sqdAmount, toWorkerPool, toBurn);
        return sqdAmount;
    }

    /**
     * @dev computes minimum sqd output from twap oracle for slippage protection.
     * reads twap ticks from both hops (rewardToken/weth + weth/sqd), converts to price,
     * and applies maxSlippageBPS tolerance.
     */
    function _computeTwapMinOut(address rewardToken, uint256 amountIn) internal view returns (uint256) {
        int24 tick1 = _getTwapTick(rewardToken, weth, oraclePoolFee);
        int24 tick2 = _getTwapTick(weth, address(sqd), oraclePoolFee2);

        // combined tick represents the full path price
        int24 combinedTick = tick1 + tick2;

        // convert tick to price: price = 1.0001^tick
        // for amountOut: if tick is negative, output > input (token0 cheaper than token1)
        // use the standard tick-to-sqrtPrice approximation
        uint256 expectedOut = _getAmountFromTick(amountIn, combinedTick);

        // apply slippage tolerance
        return FullMath.mulDiv(expectedOut, BASIS_POINTS - maxSlippageBPS, BASIS_POINTS);
    }

    /**
     * @dev reads twap tick from a pancakeswap v3 pool over the configured window.
     */
    function _getTwapTick(address tokenA, address tokenB, uint24 fee) internal view returns (int24) {
        address pool = pancakeFactory.getPool(tokenA, tokenB, fee);
        if (pool == address(0)) return 0;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = IPancakeV3Pool(pool).observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 twapTick = int24(tickDelta / int56(int32(twapWindow)));

        // adjust sign: if tokenA > tokenB, pool stores inverted tick
        if (tokenA > tokenB) {
            twapTick = -twapTick;
        }

        return twapTick;
    }

    /**
     * @dev converts a tick to an expected output amount using TickMath.
     * price = (sqrtPrice / 2^96)^2, so amountOut = amountIn / price.
     * @param amountIn input amount.
     * @param tick combined twap tick.
     * @return expected output amount.
     */
    function _getAmountFromTick(uint256 amountIn, int24 tick) internal pure returns (uint256) {
        // get sqrtPriceX96 from tick using PancakeSwap's TickMath
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);

        // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
        // amountOut = amountIn / price = amountIn * 2^192 / sqrtPriceX96^2
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 priceX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return FullMath.mulDiv(amountIn, 1 << 192, priceX192);
        } else {
            uint256 priceX128 = FullMath.mulDiv(uint256(sqrtPriceX96), sqrtPriceX96, 1 << 64);
            return FullMath.mulDiv(amountIn, 1 << 128, priceX128);
        }
    }

    function _validatePoolFee(uint24 fee) internal pure {
        if (fee != 100 && fee != 500 && fee != 2500 && fee != 10000) {
            revert PoolErrors.InvalidPoolFee();
        }
    }
}
