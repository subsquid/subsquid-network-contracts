// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IPancakeV3Factory (minimal)
 * @dev only getPool needed for oracle pool lookup.
 */
interface IPancakeV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
