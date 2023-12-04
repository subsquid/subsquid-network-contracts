// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import "../src/NetworkController.sol";
import "../src/Staking.sol";
import "../src/WorkerRegistration.sol";
import "../src/RewardTreasury.sol";
import "../src/RewardCalculation.sol";
import "../src/DistributedRewardDistribution.sol";
import "../src/GatewayRegistry.sol";
import "../src/Router.sol";

// TODO use Router
contract Deploy is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);
    //
    IERC20WithMetadata token = IERC20WithMetadata(address(0x6a117CBe9Bfab42151396FC54ddb588151a8Aac7));
    //        NetworkController network = NetworkController(address(0xF0512AD4f8945Ba47B9100609122B4B2769cA99C));
    //        Staking staking = Staking(address(0x99Fa79f673ffa4354e96670999cb67A0d43de4C1));
    //        WorkerRegistration workerRegistration = WorkerRegistration(address(0x6867E96A0259E68A571a368C0b8d733Aa56E3915));
    //        RewardTreasury treasury = RewardTreasury(address(0x87F1B67c10237CBB32019EF33052B96940994149));
    //        RewardCalculation rc = RewardCalculation(address(0xC60CA978Bf5A9E2374B82D346d1B36Fd35D27991));
    //
    //        Router router = Router(address(new TransparentUpgradeableProxy(address(new Router()), address(1234), "")));
    Router router = Router(address(0x94B8d3f47B4006f6bc71890496cc33f41DE0196d));
    //        router.initialize(workerRegistration, staking, address(treasury), network, rc);

    new GatewayRegistry(token, router);

    vm.stopBroadcast();
  }
}
