// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IRouter.sol";
import "./AccessControlledPausableUpgradeableV2.sol";
import "../v2/TemporaryHoldingV2.sol";

contract TemporaryHoldingFactoryV2 is AccessControlledPausableUpgradeableV2 {
  bytes32 public constant HOLDING_CREATOR_ROLE = keccak256("HOLDING_CREATOR_ROLE");

  IERC20 public token;
  IRouter public router;

  event TemporaryHoldingCreated(
    TemporaryHoldingV2 indexed vesting,
    address indexed beneficiaryAddress,
    address indexed admin,
    uint64 unlockTimestamp,
    uint256 expectedTotalAmount
  );

  function initialize(IERC20 _token, IRouter _router) external initializer {
    __AccessControlledPausableUpgradeableV2_init();
    token = _token;
    router = _router;
    _grantRole(HOLDING_CREATOR_ROLE, msg.sender);
  }

  function createTemporaryHolding(
    address beneficiaryAddress,
    address admin,
    uint64 unlockTimestamp,
    uint256 expectedTotalAmount
  ) external onlyRole(HOLDING_CREATOR_ROLE) whenNotPaused returns (TemporaryHoldingV2) {
    TemporaryHoldingV2 holding =
      new TemporaryHoldingV2(token, router, beneficiaryAddress, admin, unlockTimestamp, expectedTotalAmount);
    emit TemporaryHoldingCreated(holding, beneficiaryAddress, admin, unlockTimestamp, expectedTotalAmount);
    return holding;
  }

  uint256[48] private __gap;
}
