// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title External Storage Load
/// @notice Allows external contracts to read arbitrary storage slots
/// @dev Safe for upgradeable contracts - adds no storage variables
/// @dev Based on Uniswap V4's Extsload pattern
abstract contract Extsload {
    /// @notice Read a single storage slot
    /// @param slot The storage slot to read
    /// @return value The value stored in the slot
    function extsload(bytes32 slot) external view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    /// @notice Read multiple storage slots in a single call
    /// @param slots Array of storage slots to read
    /// @return values Array of values from each slot
    function extsload(bytes32[] calldata slots) external view returns (bytes32[] memory values) {
        values = new bytes32[](slots.length);
        assembly ("memory-safe") {
            for { let i := 0 } lt(i, slots.length) { i := add(i, 1) } {
                let slot := calldataload(add(slots.offset, mul(i, 32)))
                mstore(add(add(values, 32), mul(i, 32)), sload(slot))
            }
        }
    }

    /// @notice Read a sequence of contiguous storage slots
    /// @param startSlot The first slot to read
    /// @param nSlots Number of consecutive slots to read
    /// @return values Array of values from the contiguous slots
    function extsload(bytes32 startSlot, uint256 nSlots) external view returns (bytes32[] memory values) {
        values = new bytes32[](nSlots);
        assembly ("memory-safe") {
            for { let i := 0 } lt(i, nSlots) { i := add(i, 1) } {
                mstore(add(add(values, 32), mul(i, 32)), sload(add(startSlot, i)))
            }
        }
    }
}
