// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

import "../src/NetworkController.sol";
import "../src/Staking.sol";
import "../src/WorkerRegistration.sol";
import "../src/RewardTreasury.sol";
import "../src/RewardCalculation.sol";
import "../src/DistributedRewardsDistribution.sol";
import "../src/SQD.sol";
import "../src/Router.sol";
import "../src/GatewayRegistry.sol";
import "../src/VestingFactory.sol";
import "../src/SoftCap.sol";
import "../src/gateway-strategies/EqualStrategy.sol";
import "../src/AllocationsViewer.sol";

contract Deploy is Script {
  address proxyAdmin = 0xcC33ac93745811b320F2DCe730bFd1ec94599F5d;
  Router router = Router(0x6bAc05cDe58D02953496541b4d615f71a5Db57a3);
  IERC20WithMetadata token = IERC20WithMetadata(0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c);

  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    GatewayRegistry gatewayReg =
      GatewayRegistry(address(new TransparentUpgradeableProxy(address(new GatewayRegistry()), proxyAdmin, "")));
    gatewayReg.initialize(token, router);
    EqualStrategy strategy = new EqualStrategy(router, gatewayReg);
    gatewayReg.setIsStrategyAllowed(address(strategy), true, true);
    AllocationsViewer viewer = new AllocationsViewer(gatewayReg);

    vm.stopBroadcast();
  }
}
