// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Errors} from "./libs/Errors.sol";

contract FeeRouterModule is Ownable {
    using SafeERC20 for IERC20;

    struct FeeConfig {
        uint16 sqdProvidersBps;
        uint16 workerPoolBps;
        address workerPoolAddress;
    }

    FeeConfig public feeConfig;

    event FeeConfigUpdated(uint16 sqdProvidersBps, uint16 workerPoolBps, address workerPoolAddress);
    event FeesRouted(address indexed portal, address indexed token, uint256 toProviders, uint256 toWorkers);

    constructor(
        uint16 initialSqdProvidersBps,
        uint16 initialWorkerPoolBps,
        address initialWorkerPoolAddress
    ) Ownable(msg.sender) {
        if (initialWorkerPoolAddress == address(0)) revert Errors.InvalidAddress();
        if (uint256(initialSqdProvidersBps) + uint256(initialWorkerPoolBps) != 10000) {
            revert Errors.InvalidSplit();
        }

        feeConfig = FeeConfig({
            sqdProvidersBps: initialSqdProvidersBps,
            workerPoolBps: initialWorkerPoolBps,
            workerPoolAddress: initialWorkerPoolAddress
        });
    }

    function setFeeConfig(FeeConfig calldata config) external onlyOwner {
        if (config.workerPoolAddress == address(0)) revert Errors.InvalidAddress();
        if (uint256(config.sqdProvidersBps) + uint256(config.workerPoolBps) != 10000) {
            revert Errors.InvalidSplit();
        }

        feeConfig = config;
        emit FeeConfigUpdated(config.sqdProvidersBps, config.workerPoolBps, config.workerPoolAddress);
    }

    function routeFees(address portal, IERC20 token, uint256 totalAmount) external returns (uint256 toProviders, uint256 toWorkers, uint256) {
        if (totalAmount == 0) revert Errors.ZeroAmount();

        FeeConfig memory config = feeConfig;

        toProviders = (totalAmount * config.sqdProvidersBps) / 10000;
        toWorkers = totalAmount - toProviders;

        token.safeTransferFrom(portal, portal, toProviders);
        token.safeTransferFrom(portal, config.workerPoolAddress, toWorkers);

        emit FeesRouted(portal, address(token), toProviders, toWorkers);

        return (toProviders, toWorkers, 0);
    }
}
