// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "../../src/WorkerRegistration.sol";
import "../../src/testnet/tSQD.sol";
import "../../src/NetworkController.sol";
import "../../src/Staking.sol";
import "../BaseTest.sol";

contract WorkerRegistrationTest is BaseTest {
  uint128 constant EPOCH_LENGTH = 2;
  WorkerRegistration public workerRegistration;
  NetworkController public networkController;
  Staking public staking;
  IERC20 public token;

  address creator = address(this);
  bytes public workerId = "test-peer-id-1";
  bytes public workerId2 = "test-peer-id-2";

  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);
  event Delegated(uint256 indexed workerId, address indexed staker, uint256 amount);
  event Unstaked(uint256 indexed workerId, address indexed staker, uint256 amount);

  function nextEpoch() internal view returns (uint128) {
    return (uint128(block.number) / 2 + 1) * 2;
  }

  function jumpEpoch() internal {
    vm.roll(block.number + 3);
  }

  function setUp() public {
    (tSQD _token, Router router) = deployAll();
    token = _token;
    workerRegistration = WorkerRegistration(address(router.workerRegistration()));
    networkController = NetworkController(address(router.networkController()));
    networkController.setEpochLength(EPOCH_LENGTH);
    staking = Staking(address(router.staking()));
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
  }
}
