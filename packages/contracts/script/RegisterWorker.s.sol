// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "../src/WorkerRegistration.sol";

contract RegisterWorker is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    bytes memory peerId = vm.envBytes("WORKER_ID");
    WorkerRegistration workerRegistration = WorkerRegistration(vm.envAddress("WORKER_REGISTRATION"));
    IERC20 token = workerRegistration.tSQD();
    vm.startBroadcast(deployerPrivateKey);
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
    workerRegistration.register(peerId);
    vm.stopBroadcast();
  }
}
