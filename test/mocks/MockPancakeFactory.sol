// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPancakeV3Factory} from "../../src/interfaces/IPancakeV3Factory.sol";

/**
 * @dev mock pancakeswap v3 factory. returns preconfigured pool addresses.
 */
contract MockPancakeFactory is IPancakeV3Factory {
    mapping(bytes32 => address) private _pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        _pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view override returns (address) {
        address pool = _pools[_key(tokenA, tokenB, fee)];
        if (pool != address(0)) return pool;
        return _pools[_key(tokenB, tokenA, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b, fee));
    }
}
