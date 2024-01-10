// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IRouter.sol";
import "./Vesting.sol";
import "./AccessControlledPausable.sol";

/**
 * @title Subsquid Vesting Contract Factory
 * @dev Contract used to deploy vesting contracts
 */
contract VestingFactory is AccessControlledPausable {
  bytes32 public constant VESTING_CREATOR_ROLE = keccak256("VESTING_CREATOR_ROLE");

  IERC20 public immutable token;
  IRouter public immutable router;

  event VestingCreated(
    SubsquidVesting indexed vesting,
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

  function allowVestingCreator(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _grantRole(VESTING_CREATOR_ROLE, account);
  }

  function createVesting(
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 immediateReleaseBIP,
    uint256 expectedTotalAmount
  ) external onlyRole(VESTING_CREATOR_ROLE) whenNotPaused returns (SubsquidVesting) {
    SubsquidVesting vesting = new SubsquidVesting(
      token, router, beneficiaryAddress, startTimestamp, durationSeconds, immediateReleaseBIP, expectedTotalAmount
    );
    emit VestingCreated(vesting, beneficiaryAddress, startTimestamp, durationSeconds, expectedTotalAmount);
    return vesting;
  }
}
