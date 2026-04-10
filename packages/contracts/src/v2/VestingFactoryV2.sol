// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IRouter.sol";
import "../v2/VestingV2.sol";
import "./AccessControlledPausableUpgradeableV2.sol";

contract VestingFactoryV2 is AccessControlledPausableUpgradeableV2 {
  bytes32 public constant VESTING_CREATOR_ROLE = keccak256("VESTING_CREATOR_ROLE");

  IERC20 public token;
  IRouter public router;

  event VestingCreated(
    SubsquidVestingV2 indexed vesting,
    address indexed beneficiary,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 expectedTotalAmount
  );

  function initialize(IERC20 _token, IRouter _router) external initializer {
    __AccessControlledPausableUpgradeableV2_init();
    token = _token;
    router = _router;
    _grantRole(VESTING_CREATOR_ROLE, msg.sender);
  }

  function createVesting(
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 immediateReleaseBIP,
    uint256 expectedTotalAmount
  ) external onlyRole(VESTING_CREATOR_ROLE) whenNotPaused returns (SubsquidVestingV2) {
    SubsquidVestingV2 vesting = new SubsquidVestingV2(
      token, router, beneficiaryAddress, startTimestamp, durationSeconds, immediateReleaseBIP, expectedTotalAmount
    );
    emit VestingCreated(vesting, beneficiaryAddress, startTimestamp, durationSeconds, expectedTotalAmount);
    return vesting;
  }

  uint256[48] private __gap;
}
