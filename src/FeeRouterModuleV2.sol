// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IPancakeV3Router} from "./interfaces/IPancakeV3Router.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {FullMath} from "./libs/FullMath.sol";

/// @title Fee Router Module V2
contract FeeRouterModuleV2 is AccessControl, Pausable, ReentrancyGuard, IFeeRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;
    uint8 public constant SKIP_DISABLED = 0;
    uint8 public constant SKIP_BELOW_THRESHOLD = 1;

    address public sqdBurnAddress;
    uint24 public poolFee;
    bool public buybackEnabled;
    bool public autoBuybackEnabled;

    address public weth;
    uint24 public poolFee2;

    FeeConfig public feeConfig;
    address public workerPoolAddress;
    IPancakeV3Router public pancakeRouter;
    IERC20 public sqd;
    uint256 public minBuybackThreshold;

    mapping(address => bool) public allowedRewardTokens;
    mapping(address => uint256) public accumulatedForBuyback;
    address[] public accumulatedTokens;
    mapping(address => bool) private _isAccumulatedToken;

    event BuybackExecuted(address indexed rewardToken, uint256 amountIn, uint256 sqdBurned);
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

    /**
     * @dev initializes the fee router with default 50/50 split between providers and worker pool.
     */
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        feeConfig = FeeConfig({toProvidersBPS: 5000, toWorkerPoolBPS: 5000, toBurnBPS: 0});
        sqdBurnAddress = address(0xdead);
        poolFee = 2500;
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
        override
        returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn)
    {
        FeeConfig memory cfg = feeConfig;

        toProviders = FullMath.mulDiv(amount, cfg.toProvidersBPS, BASIS_POINTS);
        toWorkerPool = FullMath.mulDiv(amount, cfg.toWorkerPoolBPS, BASIS_POINTS);
        toBurn = FullMath.mulDiv(amount, cfg.toBurnBPS, BASIS_POINTS);

        uint256 used = toProviders + toWorkerPool + toBurn;
        if (used > amount) revert PoolErrors.InvalidFeeConfig();

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
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (toProvidersBPS + toWorkerPoolBPS + toBurnBPS != BASIS_POINTS) {
            revert PoolErrors.InvalidFeeConfig();
        }

        feeConfig = FeeConfig({
            toProvidersBPS: toProvidersBPS,
            toWorkerPoolBPS: toWorkerPoolBPS,
            toBurnBPS: toBurnBPS
        });

        emit FeeConfigUpdated(toProvidersBPS, toWorkerPoolBPS, toBurnBPS);
    }

    /**
     * @dev returns the current fee configuration.
     */
    function getFeeConfig() external view override returns (FeeConfig memory) {
        return feeConfig;
    }

    /**
     * @dev returns the contract address for token accumulation.
     * @notice Tokens sent here are accumulated for buyback.
     */
    function getBurnAddress() external view override returns (address) {
        return address(this);
    }

    /**
     * @dev routes tokens from caller to worker pool.
     * @notice Caller must approve this contract first.
     * @param rewardToken the token to route.
     * @param amount the amount to route.
     */
    function routeToWorkerPool(address rewardToken, uint256 amount) external whenNotPaused {
        if (amount == 0) return;
        if (workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        IERC20(rewardToken).safeTransferFrom(msg.sender, workerPoolAddress, amount);
        emit RoutedToWorkerPool(msg.sender, rewardToken, amount);
    }

    /**
     * @dev routes tokens from caller to this contract for buyback accumulation.
     * @notice Caller must approve this contract first. May trigger auto-buyback.
     * @dev uses balance delta for fee-on-transfer token safety.
     * @param rewardToken the token to route.
     * @param amount the amount to route.
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
     * @dev executes a buyback swap for the given reward token.
     * @notice Callable by anyone. Caller sets minSqdOut for slippage protection.
     * @param rewardToken the reward token to swap.
     * @param minSqdOut minimum SQD output (slippage protection).
     * @return sqdBought amount of SQD purchased and burned.
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
     * @dev returns the pending balance available for buyback.
     * @param rewardToken the token to check.
     * @return balance available for buyback.
     */
    function getPendingBuyback(address rewardToken) external view returns (uint256) {
        return IERC20(rewardToken).balanceOf(address(this));
    }

    /**
     * @dev returns all accumulated token addresses and their balances.
     * @return tokens array of token addresses.
     * @return amounts array of corresponding balances.
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
     * @dev configures the buyback swap parameters.
     * @param _pancakeRouter PancakeSwap V3 router address.
     * @param _sqd SQD token address.
     * @param _weth WETH token address for multi-hop.
     * @param _poolFee pool fee tier for first hop (rewardToken -> WETH).
     * @param _poolFee2 pool fee tier for second hop (WETH -> SQD).
     * @param _minBuybackThreshold minimum amount to trigger buyback.
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

    /**
     * @dev returns the current buyback configuration.
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
     * @dev enables or disables buyback functionality.
     * @param enabled true to enable, false to disable.
     */
    function setBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        buybackEnabled = enabled;
        emit BuybackEnabledChanged(enabled);
    }

    /**
     * @dev enables or disables automatic buyback on routeToBurn.
     * @param enabled true to enable, false to disable.
     */
    function setAutoBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        autoBuybackEnabled = enabled;
        emit AutoBuybackEnabledChanged(enabled);
    }

    /**
     * @dev sets whether a reward token is allowed for buyback.
     * @param token the token address.
     * @param allowed true to allow, false to disallow.
     */
    function setAllowedRewardToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedRewardTokens[token] = allowed;
        emit RewardTokenAllowed(token, allowed);
    }

    /**
     * @dev sets the pool fee for the first hop (rewardToken -> WETH).
     * @param _poolFee pool fee tier (100, 500, 2500, or 10000).
     */
    function setPoolFee(uint24 _poolFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validatePoolFee(_poolFee);
        poolFee = _poolFee;
        emit PoolFeeChanged(_poolFee);
    }

    /**
     * @dev sets the pool fee for the second hop (WETH -> SQD).
     * @param _poolFee2 pool fee tier (100, 500, 2500, or 10000).
     */
    function setPoolFee2(uint24 _poolFee2) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validatePoolFee(_poolFee2);
        poolFee2 = _poolFee2;
        emit PoolFee2Changed(_poolFee2);
    }

    /**
     * @dev sets the WETH address for multi-hop swaps.
     * @param _weth WETH token address.
     */
    function setWeth(address _weth) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_weth == address(0)) revert PoolErrors.InvalidAddress();
        weth = _weth;
        emit WethChanged(_weth);
    }

    /**
     * @dev sets the minimum threshold for buyback execution.
     * @param _minBuybackThreshold minimum amount required.
     */
    function setMinBuybackThreshold(uint256 _minBuybackThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBuybackThreshold = _minBuybackThreshold;
        emit MinBuybackThresholdChanged(_minBuybackThreshold);
    }

    /**
     * @dev sets the SQD burn address where purchased SQD is sent.
     * @param newBurnAddress the new burn address.
     */
    function setBurnAddress(address newBurnAddress) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBurnAddress == address(0)) revert PoolErrors.InvalidAddress();
        sqdBurnAddress = newBurnAddress;
        emit BurnAddressUpdated(newBurnAddress);
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
     * @dev pauses all routing and buyback operations.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @dev unpauses all routing and buyback operations.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev recovers tokens accidentally sent to this contract.
     * @notice Cannot recover allowed reward tokens (use executeBuyback instead).
     * @param token the token to recover.
     * @param to the recipient address.
     * @param amount the amount to recover.
     */
    function recoverTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert PoolErrors.InvalidAddress();
        if (allowedRewardTokens[token]) revert PoolErrors.TokenNotAllowed();
        IERC20(token).safeTransfer(to, amount);
    }

    function _executeBuybackInternal(address rewardToken, uint256 minSqdOut) internal returns (uint256 sqdBought) {
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) return 0;

        accumulatedForBuyback[rewardToken] = 0;

        if (
            !buybackEnabled || address(pancakeRouter) == address(0) || address(sqd) == address(0) || weth == address(0)
        ) {
            IERC20(rewardToken).safeTransfer(sqdBurnAddress, balance);
            emit BuybackSkipped(balance, SKIP_DISABLED);
            return 0;
        }

        if (balance < minBuybackThreshold) {
            accumulatedForBuyback[rewardToken] = balance;
            emit BuybackSkipped(balance, SKIP_BELOW_THRESHOLD);
            return 0;
        }

        IERC20(rewardToken).forceApprove(address(pancakeRouter), balance);

        bytes memory path = abi.encodePacked(rewardToken, poolFee, weth, poolFee2, address(sqd));

        IPancakeV3Router.ExactInputParams memory params = IPancakeV3Router.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: balance,
            amountOutMinimum: minSqdOut
        });

        sqdBought = pancakeRouter.exactInput(params);

        sqd.safeTransfer(sqdBurnAddress, sqdBought);

        emit BuybackExecuted(rewardToken, balance, sqdBought);
    }

    function _validatePoolFee(uint24 fee) internal pure {
        if (fee != 100 && fee != 500 && fee != 2500 && fee != 10000) {
            revert PoolErrors.InvalidPoolFee();
        }
    }
}
