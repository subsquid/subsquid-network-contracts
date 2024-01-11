// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "../src/WorkerRegistration.sol";

contract RegisterWorker is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
    bytes memory peerId = vm.envOr("WORKER_ID", bytes(""));
    WorkerRegistration workerRegistration = WorkerRegistration(vm.envOr("WORKER_REGISTRATION", address(0x7Bf0B1ee9767eAc70A857cEbb24b83115093477F)));
    if (deployerPrivateKey == 0) {
      console2.log("PRIVATE_KEY env var is required");
      return;
    }
    if (peerId.length == 0) {
      console2.log("WORKER_ID env var is required");
      return;
    }
    IERC20 token = workerRegistration.tSQD();
    vm.startBroadcast(deployerPrivateKey);
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
    workerRegistration.register(peerId);
    vm.stopBroadcast();
  }
}
