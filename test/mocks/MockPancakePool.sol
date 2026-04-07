// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPancakeV3Pool} from "../../src/interfaces/IPancakeV3Pool.sol";

/**
 * @dev mock pancakeswap v3 pool for twap oracle testing.
 * admin sets the tick cumulatives directly.
 */
contract MockPancakePool is IPancakeV3Pool {
    address public token0Addr;
    address public token1Addr;
    int24 public currentTick;
    int56 public tickCumulative0; // value at secondsAgo[0]
    int56 public tickCumulative1; // value at secondsAgo[1] (now)

    constructor(address _token0, address _token1) {
        token0Addr = _token0;
        token1Addr = _token1;
    }

    function setTick(int24 _tick) external {
        currentTick = _tick;
    }

    function setTickCumulatives(int56 _cum0, int56 _cum1) external {
        tickCumulative0 = _cum0;
        tickCumulative1 = _cum1;
    }

    function observe(uint32[] calldata)
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](2);
        tickCumulatives[0] = tickCumulative0;
        tickCumulatives[1] = tickCumulative1;

        secondsPerLiquidityCumulativeX128s = new uint160[](2);
        secondsPerLiquidityCumulativeX128s[0] = 0;
        secondsPerLiquidityCumulativeX128s[1] = 0;
    }

    function slot0() external view override returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (0, currentTick, 0, 100, 100, 0, true);
    }

    function token0() external view override returns (address) {
        return token0Addr;
    }

    function token1() external view override returns (address) {
        return token1Addr;
    }
}
