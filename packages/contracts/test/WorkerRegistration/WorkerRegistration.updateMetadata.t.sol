// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./WorkerRegistration.sol";

contract WorkerRegistrationUpdateMetadataTest is WorkerRegistrationTest {
  function test_RevertsIf_NotWorkerCreator() public {
    workerRegistration.register(workerId);
    hoax(address(1));
    vm.expectRevert("Not worker creator");
    workerRegistration.updateMetadata(workerId, "new metadata");
  }

  function test_UpdatesMetadata() public {
    workerRegistration.register(workerId);
    workerRegistration.updateMetadata(workerId, "new metadata");
    assertEq(workerRegistration.getMetadata(workerId), "new metadata");
  }

  event MetadataUpdated(uint256 indexed workerId, string metadata);

  function test_EmitsEvent() public {
    workerRegistration.register(workerId);
    vm.expectEmit(address(workerRegistration));
    emit MetadataUpdated(1, "new metadata");
    workerRegistration.updateMetadata(workerId, "new metadata");
  }
}
