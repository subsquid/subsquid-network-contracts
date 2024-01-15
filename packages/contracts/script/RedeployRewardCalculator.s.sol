// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "../src/Router.sol";
import "../src/NetworkController.sol";
import "../src/RewardCalculation.sol";

contract RedeployRewardCalculator is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    Router router = Router(address(0x6bAc05cDe58D02953496541b4d615f71a5Db57a3));
    address[] memory allowedTargets = new address[](2);
    vm.startBroadcast(deployerPrivateKey);
    allowedTargets[0] = address(router.workerRegistration());
    allowedTargets[1] = address(router.staking());
    NetworkController network = new NetworkController(100, 100000 ether, allowedTargets);
    RewardCalculation rc = new RewardCalculation(router);

    router.setNetworkController(network);
    router.setRewardCalculation(rc);

    vm.stopBroadcast();
  }
}
