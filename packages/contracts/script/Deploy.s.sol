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
import "../src/testnet/tSQD.sol";
import "../src/Router.sol";

contract Deploy is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    address[] memory recipients = new address[](1);
    recipients[0] = vm.addr(deployerPrivateKey);
    uint256[] memory amounts = new uint256[](1);
    amounts[0] = 100;
    tSQD token = new tSQD(recipients, amounts);
    Router router = Router(address(new TransparentUpgradeableProxy(address(new Router()), msg.sender, "")));

    NetworkController network = new NetworkController(100, 100000 ether, new address[](0));
    Staking staking = new Staking(token, router);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, router);
    RewardTreasury treasury = new RewardTreasury(token);
    DistributedRewardsDistribution distributor = new DistributedRewardsDistribution(router);
    router.initialize(workerRegistration, staking, address(treasury), network, new RewardCalculation(router));
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(distributor));
    treasury.setWhitelistedDistributor(distributor, true);
    distributor.grantRole(distributor.REWARDS_TREASURY_ROLE(), address(treasury));

    vm.stopBroadcast();
  }
}
