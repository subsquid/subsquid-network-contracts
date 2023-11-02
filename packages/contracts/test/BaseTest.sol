// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "forge-std/Test.sol";
import "../src/WorkerRegistration.sol";
import "../src/Staking.sol";
import "../src/NetworkController.sol";
import "../src/RewardTreasury.sol";
import "../src/Router.sol";
import "../src/testnet/tSQD.sol";

contract BaseTest is Test {
  function deployAll() internal returns (tSQD token, Router router) {
    router = Router(address(new TransparentUpgradeableProxy(address(new Router()), address(1234), "")));
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    token = new tSQD(holders, shares);

    IWorkerRegistration workerRegistration = new WorkerRegistration(token, router);
    IStaking staking = new Staking(token, router);
    INetworkController networkController = new NetworkController(5, 10 ether);
    RewardTreasury treasury = new RewardTreasury(token);
    router.initialize(workerRegistration, staking, address(treasury), networkController);
  }
}
