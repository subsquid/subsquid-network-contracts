// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPancakeV3Router} from "../../src/interfaces/IPancakeV3Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title Mock PancakeSwap V3 Router for testing
/// @dev Returns a configurable exchange rate. Pulls tokenIn, mints tokenOut.
contract MockPancakeRouter is IPancakeV3Router {
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    bool public shouldRevert;

    function setRate(uint256 _num, uint256 _den) external {
        rateNum = _num;
        rateDen = _den;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(!shouldRevert, "MockRouter: forced revert");
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * rateNum / rateDen;
        require(amountOut >= params.amountOutMinimum, "MockRouter: insufficient output");
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);
        return amountOut;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(!shouldRevert, "MockRouter: forced revert");

        // Decode path: first 20 bytes = tokenIn, last 20 bytes = tokenOut
        bytes memory path = params.path;
        address tokenIn;
        address tokenOut;

        require(path.length >= 40, "MockRouter: path too short");

        // First 20 bytes
        assembly {
            tokenIn := mload(add(path, 20))
        }
        // Last 20 bytes
        assembly {
            tokenOut := mload(add(path, mload(path)))
        }

        IERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * rateNum / rateDen;
        require(amountOut >= params.amountOutMinimum, "MockRouter: insufficient output");
        MockERC20(tokenOut).mint(params.recipient, amountOut);
        return amountOut;
    }
}
