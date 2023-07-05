// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "forge-std/Test.sol";
import "../contracts/WorkerRegistration.sol";
import "../contracts/tSQD.sol";

contract WorkerRegistrationTest is Test {
    uint256 constant creatorPrivateKey = 0xabc123;

    uint128 constant EPOCH_LENGTH = 2;
    WorkerRegistration public workerRegistration;
    IERC20 public token;

    address creator = vm.addr(creatorPrivateKey);
    bytes32[2] public workerId = [bytes32("test-peer-id-1"), "test-peer-id-2"];

    event WorkerRegistered(uint256 indexed workerId, address indexed workerAccount, address indexed registrar, bytes32 peerId0, bytes32 peerId1, uint256 registeredAt);

    function setUp() public {
        startHoax(creator);

        uint256[] memory shares = new uint256[](1);
        shares[0] = 100;
        address[] memory holders = new address[](1);
        holders[0] = creator;

        token = new tSQD(holders, shares);
        workerRegistration = new WorkerRegistration(token, EPOCH_LENGTH);
        token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT());
    }

    function testConstructor() public {
        assertEq(address(workerRegistration.tSQD()), address(token));
        assertEq(workerRegistration.epochLength(), EPOCH_LENGTH);
        assertEq(workerRegistration.lockPeriod(), EPOCH_LENGTH);
    }
}
