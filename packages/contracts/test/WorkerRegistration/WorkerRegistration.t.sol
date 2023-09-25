// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "../../src/WorkerRegistration.sol";
import "../../src/testnet/tSQD.sol";
import "../../src/NetworkController.sol";
import "../../src/Staking.sol";

contract WorkerRegistrationTest is Test {
  uint256 constant creatorPrivateKey = 0xabc123;

  uint128 constant EPOCH_LENGTH = 2;
  WorkerRegistration public workerRegistration;
  INetworkController public networkController;
  Staking public staking;
  IERC20 public token;

  address creator = vm.addr(creatorPrivateKey);
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
    startHoax(creator);
    networkController = new NetworkController(EPOCH_LENGTH, 100);
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = creator;

    token = new tSQD(holders, shares);
    staking = new Staking(token, networkController);
    workerRegistration = new WorkerRegistration(token, networkController, staking);
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
  }
}
