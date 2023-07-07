// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "forge-std/Test.sol";
import "../../contracts/WorkerRegistration.sol";
import "../../contracts/tSQD.sol";

contract WorkerRegistrationTest is Test {
    uint256 constant creatorPrivateKey = 0xabc123;

    uint128 constant EPOCH_LENGTH = 2;
    WorkerRegistration public workerRegistration;
    IERC20 public token;

    address creator = vm.addr(creatorPrivateKey);
    string public workerId = "test-peer-id-1";
    string public workerId2 = "test-peer-id-2";

    event WorkerRegistered(
        uint256 indexed workerId,
        string indexed peerId,
        address indexed registrar,
        uint256 registeredAt
    );
    event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
    event WorkerWithdrawn(uint256 indexed workerId, address indexed account);

    function nextEpoch() internal view returns (uint128) {
        return (uint128(block.number) / 2 + 1) * 2;
    }

    function jumpEpoch() internal {
        vm.roll(block.number + 3);
    }

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
}
