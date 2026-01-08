// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Multicall
/// @notice Enables batching multiple function calls in a single transaction
/// @dev Safe for upgradeable contracts - adds no storage variables
/// @dev Uses delegatecall to preserve msg.sender context
abstract contract Multicall {
    /// @notice Execute multiple calls atomically - reverts if any call fails
    /// @param data Array of encoded function calls
    /// @return results Array of return data from each call
    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length;) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);

            if (!success) {
                // Bubble up the revert reason
                _bubbleRevert(result);
            }

            results[i] = result;
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Execute multiple calls - continues even if some fail
    /// @param data Array of encoded function calls
    /// @return successes Array of success flags for each call
    /// @return results Array of return data from each call
    function tryMulticall(bytes[] calldata data) external returns (bool[] memory successes, bytes[] memory results) {
        successes = new bool[](data.length);
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length;) {
            (successes[i], results[i]) = address(this).delegatecall(data[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Bubbles up the revert reason from a failed delegatecall
    function _bubbleRevert(bytes memory revertData) private pure {
        assembly ("memory-safe") {
            revert(add(revertData, 32), mload(revertData))
        }
    }
}
