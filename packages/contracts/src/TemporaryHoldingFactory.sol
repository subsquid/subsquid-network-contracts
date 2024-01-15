// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IRouter.sol";
import "./AccessControlledPausable.sol";
import "./TemporaryHolding.sol";

/**
 * @title Subsquid Temporary Holding Contract Factory
 * @dev Contract used to deploy holding contracts
 */
contract TemporaryHoldingFactory is AccessControlledPausable {
  bytes32 public constant HOLDING_CREATOR_ROLE = keccak256("HOLDING_CREATOR_ROLE");

  IERC20 public immutable token;
  IRouter public immutable router;

  event TemporaryHoldingCreated(
    TemporaryHolding indexed vesting,
    address indexed beneficiaryAddress,
    address indexed admin,
    uint64 unlockTimestamp,
    uint256 expectedTotalAmount
  );

  constructor(IERC20 _token, IRouter _router) {
    token = _token;
    router = _router;
    _grantRole(HOLDING_CREATOR_ROLE, msg.sender);
  }

  function allowTemporaryHoldingCreator(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _grantRole(HOLDING_CREATOR_ROLE, account);
  }

  function createTemporaryHolding(
    address beneficiaryAddress,
    address admin,
    uint64 unlockTimestamp,
    uint256 expectedTotalAmount
  ) external onlyRole(HOLDING_CREATOR_ROLE) whenNotPaused returns (TemporaryHolding) {
    TemporaryHolding holding =
      new TemporaryHolding(token, router, beneficiaryAddress, admin, unlockTimestamp, expectedTotalAmount);
    emit TemporaryHoldingCreated(holding, beneficiaryAddress, admin, unlockTimestamp, expectedTotalAmount);
    return holding;
  }
}
