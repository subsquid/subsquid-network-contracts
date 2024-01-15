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
    address indexed beneficiary,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 expectedTotalAmount
  );

  constructor(IERC20 _token, IRouter _router) {
    token = _token;
    router = _router;
    _grantRole(VESTING_CREATOR_ROLE, msg.sender);
  }

  function allowTemporaryHoldingCreator(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _grantRole(VESTING_CREATOR_ROLE, account);
  }

  function createTemporaryHolding(
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 immediateReleaseBIP,
    uint256 expectedTotalAmount
  ) external onlyRole(HOLDING_CREATOR_ROLE) whenNotPaused returns (TemporaryHolding) {
    TemporaryHolding holding = new TemporaryHolding(
      token, router, beneficiaryAddress, startTimestamp, durationSeconds, immediateReleaseBIP, expectedTotalAmount
    );
    emit TemporaryHoldingCreated(holding, beneficiaryAddress, startTimestamp, durationSeconds, expectedTotalAmount);
    return vesting;
  }
}
