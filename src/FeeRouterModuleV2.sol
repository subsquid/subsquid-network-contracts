// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IPancakeV3Router} from "./interfaces/IPancakeV3Router.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {FullMath} from "./libs/FullMath.sol";

contract FeeRouterModuleV2 is AccessControl, Pausable, IFeeRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10000;

    FeeConfig public feeConfig;
    address public sqdBurnAddress;
    address public workerPoolAddress;
    IPancakeV3Router public pancakeRouter;
    IERC20 public sqd;
    uint24 public poolFee;
    uint256 public minBuybackThreshold;
    bool public buybackEnabled;
    mapping(address => bool) public allowedRewardTokens;
    mapping(address => uint256) public accumulatedForBuyback;
    address[] public accumulatedTokens;
    mapping(address => bool) private _isAccumulatedToken;
    bool public autoBuybackEnabled;

    error InvalidSlippage();
    error InvalidPoolFee();
    error TokenNotAllowed();
    error NothingToBuyback();

    event BuybackExecuted(address indexed rewardToken, uint256 amountIn, uint256 sqdBought);
    event BuybackSkipped(uint256 amount, string reason);
    event RewardTokenAllowed(address indexed token, bool allowed);
    event TokensAccumulated(address indexed rewardToken, uint256 amount, uint256 totalAccumulated);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        feeConfig = FeeConfig({toProvidersBPS: 5000, toWorkerPoolBPS: 5000, toBurnBPS: 0});
        sqdBurnAddress = address(0xdead);
        buybackEnabled = false;
        poolFee = 2500;
    }

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
        if (used > amount) {
            revert PoolErrors.InvalidFeeConfig();
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

    function getBurnAddress() external view override returns (address) {
        return address(this);
    }

    function executeBuyback(address rewardToken, uint256 minSqdOut)
        external
        whenNotPaused
        returns (uint256 sqdBought)
    {
        if (!allowedRewardTokens[rewardToken]) revert TokenNotAllowed();

        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) revert NothingToBuyback();

        return _executeBuybackInternal(rewardToken, minSqdOut);
    }

    function getPendingBuyback(address rewardToken) external view returns (uint256) {
        return IERC20(rewardToken).balanceOf(address(this));
    }

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

    function configureBuyback(
        address _pancakeRouter,
        address _sqd,
        uint24 _poolFee,
        uint256 _minBuybackThreshold
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pancakeRouter == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (_poolFee != 100 && _poolFee != 500 && _poolFee != 2500 && _poolFee != 10000) {
            revert InvalidPoolFee();
        }

        pancakeRouter = IPancakeV3Router(_pancakeRouter);
        sqd = IERC20(_sqd);
        poolFee = _poolFee;
        minBuybackThreshold = _minBuybackThreshold;
    }

    function setBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        buybackEnabled = enabled;
    }

    function setAllowedRewardToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedRewardTokens[token] = allowed;
        emit RewardTokenAllowed(token, allowed);
    }

    function setPoolFee(uint24 _poolFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_poolFee != 100 && _poolFee != 500 && _poolFee != 2500 && _poolFee != 10000) {
            revert InvalidPoolFee();
        }
        poolFee = _poolFee;
    }

    function setMinBuybackThreshold(uint256 _minBuybackThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBuybackThreshold = _minBuybackThreshold;
    }

    function setBurnAddress(address newBurnAddress) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBurnAddress == address(0)) revert PoolErrors.InvalidAddress();
        sqdBurnAddress = newBurnAddress;
        emit BurnAddressUpdated(newBurnAddress);
    }

    function getFeeConfig() external view override returns (FeeConfig memory) {
        return feeConfig;
    }

    function getBuybackConfig()
        external
        view
        returns (address router, address sqdToken, uint24 fee, uint256 minThreshold, bool enabled)
    {
        return (address(pancakeRouter), address(sqd), poolFee, minBuybackThreshold, buybackEnabled);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function recoverTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert PoolErrors.InvalidAddress();
        if (allowedRewardTokens[token]) revert TokenNotAllowed();
        IERC20(token).safeTransfer(to, amount);
    }

    function setWorkerPoolAddress(address _workerPoolAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        workerPoolAddress = _workerPoolAddress;
        emit WorkerPoolAddressUpdated(_workerPoolAddress);
    }

    function getWorkerPoolAddress() external view returns (address) {
        return workerPoolAddress;
    }

    function routeToWorkerPool(address rewardToken, uint256 amount) external whenNotPaused {
        if (amount == 0) return;
        if (workerPoolAddress == address(0)) revert PoolErrors.InvalidAddress();
        IERC20(rewardToken).safeTransferFrom(msg.sender, workerPoolAddress, amount);
        emit RoutedToWorkerPool(msg.sender, rewardToken, amount);
    }

    function routeToBurn(address rewardToken, uint256 amount) external whenNotPaused {
        if (amount == 0) return;
        if (!allowedRewardTokens[rewardToken]) revert TokenNotAllowed();

        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);

        accumulatedForBuyback[rewardToken] += amount;

        if (!_isAccumulatedToken[rewardToken]) {
            accumulatedTokens.push(rewardToken);
            _isAccumulatedToken[rewardToken] = true;
        }

        emit RoutedToBurn(msg.sender, rewardToken, amount);
        emit TokensAccumulated(rewardToken, amount, accumulatedForBuyback[rewardToken]);

        if (autoBuybackEnabled && accumulatedForBuyback[rewardToken] >= minBuybackThreshold) {
            _executeBuybackInternal(rewardToken, 0);
        }
    }

    function _executeBuybackInternal(address rewardToken, uint256 minSqdOut) internal returns (uint256 sqdBought) {
        uint256 balance = IERC20(rewardToken).balanceOf(address(this));
        if (balance == 0) return 0;

        accumulatedForBuyback[rewardToken] = 0;

        if (!buybackEnabled || address(pancakeRouter) == address(0) || address(sqd) == address(0)) {
            IERC20(rewardToken).safeTransfer(sqdBurnAddress, balance);
            emit BuybackSkipped(balance, "Buyback disabled or not configured");
            return 0;
        }

        if (balance < minBuybackThreshold) {
            accumulatedForBuyback[rewardToken] = balance;
            emit BuybackSkipped(balance, "Below threshold");
            return 0;
        }

        IERC20(rewardToken).forceApprove(address(pancakeRouter), balance);

        IPancakeV3Router.ExactInputSingleParams memory params = IPancakeV3Router.ExactInputSingleParams({
            tokenIn: rewardToken,
            tokenOut: address(sqd),
            fee: poolFee,
            recipient: sqdBurnAddress,
            amountIn: balance,
            amountOutMinimum: minSqdOut,
            sqrtPriceLimitX96: 0
        });

        sqdBought = pancakeRouter.exactInputSingle(params);

        emit BuybackExecuted(rewardToken, balance, sqdBought);
    }

    function getAccumulatedTokens() external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 len = accumulatedTokens.length;
        tokens = new address[](len);
        amounts = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            tokens[i] = accumulatedTokens[i];
            amounts[i] = IERC20(accumulatedTokens[i]).balanceOf(address(this));
        }
    }

    function setAutoBuybackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        autoBuybackEnabled = enabled;
    }
}
