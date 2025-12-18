// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";

/**
 * @title LiquidPortalToken
 * @notice Transferable ERC20 token representing stake in a Portal Pool
 */
contract LiquidPortalToken is ERC20 {
    address public immutable PORTAL_POOL;

    error OnlyPortalPool();

    modifier onlyPool() {
        if (msg.sender != PORTAL_POOL) revert OnlyPortalPool();
        _;
    }

    constructor(string memory name_, string memory symbol_, address portalPool_) ERC20(name_, symbol_) {
        PORTAL_POOL = portalPool_;
    }

    /**
     * @notice Mint LPT tokens to a user when they stake
     * @param to The address to mint tokens to
     * @param amount The amount of tokens to mint (1:1 with SQD staked)
     */
    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    /**
     * @notice Burn LPT tokens from a user when they exit
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (from != address(0) && to != address(0)) {
            IPortalPool(PORTAL_POOL).onLPTTransfer(from, to, value);
        }
    }
}
