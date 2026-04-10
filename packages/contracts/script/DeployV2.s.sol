// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/v2/RouterV2.sol";
import "../src/v2/NetworkControllerV2.sol";
import "../src/v2/StakingV2.sol";
import "../src/v2/WorkerRegistrationV2.sol";
import "../src/v2/RewardCalculationV2.sol";
import "../src/v2/DistributedRewardsDistributionV2.sol";
import "../src/v2/GatewayRegistryV2.sol";
import "../src/v2/SoftCapV2.sol";
import "../src/v2/EqualStrategyV2.sol";
import "../src/v2/SubequalStrategyV2.sol";
import "../src/v2/VestingFactoryV2.sol";
import "../src/v2/TemporaryHoldingFactoryV2.sol";
import "../src/RewardTreasury.sol";
import "../src/AllocationsViewer.sol";
import "../src/v2/RZLV.sol";
import "../src/interfaces/IERC20WithMetadata.sol";

contract DeployV2 is Script {
  // Storage for deployed addresses to avoid stack-too-deep
  address public tokenAddr;
  address public routerAddr;
  address public networkAddr;
  address public workerRegAddr;
  address public stakingAddr;
  address public softCapAddr;
  address public rewardCalcAddr;
  address public distributorAddr;
  address public treasuryAddr;
  address public gatewayRegAddr;
  address public eqStrategyAddr;
  address public subStrategyAddr;
  address public viewerAddr;
  address public vestingFactoryAddr;
  address public holdingFactoryAddr;

  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    address deployer = vm.addr(deployerPrivateKey);
    vm.startBroadcast(deployerPrivateKey);

    _deployToken(deployer);
    _deployCore();
    _deployRewards();
    _wireRouter();
    _deployGateway();
    _deployFactories();
    _configureRoles(deployer);

    vm.stopBroadcast();

    _printAddresses();
  }

  function _deployToken(address deployer) internal {
    tokenAddr = vm.envOr("TOKEN", address(0));
    if (tokenAddr == address(0)) {
      address[] memory recipients = new address[](1);
      recipients[0] = deployer;
      uint256[] memory amounts = new uint256[](1);
      amounts[0] = 1337 * (10 ** 6) * 1 ether;
      tokenAddr = address(new RZLV(recipients, amounts));
    }
  }

  function _deployCore() internal {
    // RouterV2 (UUPS proxy) - placeholder init, wired later
    routerAddr = address(
      new ERC1967Proxy(
        address(new RouterV2()),
        abi.encodeCall(
          RouterV2.initialize,
          (
            IWorkerRegistration(address(0)),
            IStaking(address(0)),
            address(0),
            INetworkController(address(0)),
            IRewardCalculation(address(0))
          )
        )
      )
    );

    // NetworkControllerV2 (UUPS proxy)
    networkAddr = address(
      new ERC1967Proxy(
        address(new NetworkControllerV2()),
        abi.encodeCall(NetworkControllerV2.initialize, (100, 0, 0, 100000 ether, new address[](0)))
      )
    );
    NetworkControllerV2(networkAddr).setLockPeriod(100);

    // WorkerRegistrationV2 (UUPS proxy)
    workerRegAddr = address(
      new ERC1967Proxy(
        address(new WorkerRegistrationV2()),
        abi.encodeCall(WorkerRegistrationV2.initialize, (IERC20(tokenAddr), IRouter(routerAddr)))
      )
    );

    // StakingV2 (UUPS proxy)
    stakingAddr = address(
      new ERC1967Proxy(
        address(new StakingV2()), abi.encodeCall(StakingV2.initialize, (IERC20(tokenAddr), IRouter(routerAddr)))
      )
    );

    // SoftCapV2 (UUPS proxy)
    softCapAddr =
      address(new ERC1967Proxy(address(new SoftCapV2()), abi.encodeCall(SoftCapV2.initialize, (IRouter(routerAddr)))));

    // RewardCalculationV2 (UUPS proxy)
    rewardCalcAddr = address(
      new ERC1967Proxy(
        address(new RewardCalculationV2()),
        abi.encodeCall(RewardCalculationV2.initialize, (IRouter(routerAddr), softCapAddr))
      )
    );
  }

  function _deployRewards() internal {
    // DistributedRewardsDistributionV2 (UUPS proxy)
    distributorAddr = address(
      new ERC1967Proxy(
        address(new DistributedRewardsDistribution()),
        abi.encodeCall(DistributedRewardsDistribution.initialize, (IRouter(routerAddr)))
      )
    );

    // RewardTreasury (constructor-based)
    treasuryAddr = address(new RewardTreasury(IERC20(tokenAddr)));
  }

  function _wireRouter() internal {
    RouterV2 router = RouterV2(routerAddr);
    router.setWorkerRegistration(IWorkerRegistration(workerRegAddr));
    router.setStaking(IStaking(stakingAddr));
    router.setRewardTreasury(treasuryAddr);
    router.setNetworkController(INetworkController(networkAddr));
    router.setRewardCalculation(IRewardCalculation(rewardCalcAddr));
  }

  function _deployGateway() internal {
    // GatewayRegistryV2 (UUPS proxy)
    gatewayRegAddr = address(
      new ERC1967Proxy(
        address(new GatewayRegistryV2()),
        abi.encodeCall(GatewayRegistryV2.initialize, (IERC20WithMetadata(tokenAddr), IRouter(routerAddr)))
      )
    );

    // EqualStrategyV2 (UUPS proxy)
    eqStrategyAddr = address(
      new ERC1967Proxy(
        address(new EqualStrategyV2()),
        abi.encodeCall(EqualStrategyV2.initialize, (IRouter(routerAddr), IGatewayRegistry(gatewayRegAddr)))
      )
    );

    // SubequalStrategyV2 (UUPS proxy)
    subStrategyAddr = address(
      new ERC1967Proxy(
        address(new SubequalStrategyV2()),
        abi.encodeCall(SubequalStrategyV2.initialize, (IRouter(routerAddr), IGatewayRegistry(gatewayRegAddr)))
      )
    );

    // AllocationsViewer (no proxy)
    viewerAddr = address(new AllocationsViewer(IGatewayRegistry(gatewayRegAddr)));
  }

  function _deployFactories() internal {
    // VestingFactoryV2 (UUPS proxy)
    vestingFactoryAddr = address(
      new ERC1967Proxy(
        address(new VestingFactoryV2()),
        abi.encodeCall(VestingFactoryV2.initialize, (IERC20(tokenAddr), IRouter(routerAddr)))
      )
    );

    // TemporaryHoldingFactoryV2 (UUPS proxy)
    holdingFactoryAddr = address(
      new ERC1967Proxy(
        address(new TemporaryHoldingFactoryV2()),
        abi.encodeCall(TemporaryHoldingFactoryV2.initialize, (IERC20(tokenAddr), IRouter(routerAddr)))
      )
    );
  }

  function _configureRoles(address deployer) internal {
    // Grant REWARDS_DISTRIBUTOR_ROLE on StakingV2 to DRD
    StakingV2(stakingAddr).grantRole(keccak256("REWARDS_DISTRIBUTOR_ROLE"), distributorAddr);

    // Grant REWARDS_TREASURY_ROLE on DRD to RewardTreasury
    DistributedRewardsDistribution(distributorAddr).grantRole(keccak256("REWARDS_TREASURY_ROLE"), treasuryAddr);

    // Whitelist distributor on treasury
    RewardTreasury(treasuryAddr).setWhitelistedDistributor(IRewardsDistribution(distributorAddr), true);

    // Bootstrap distributor pipeline
    DistributedRewardsDistribution(distributorAddr).addDistributor(deployer);

    // Allowed vested targets
    NetworkControllerV2 nc = NetworkControllerV2(networkAddr);
    nc.setAllowedVestedTarget(workerRegAddr, true);
    nc.setAllowedVestedTarget(stakingAddr, true);
    nc.setAllowedVestedTarget(gatewayRegAddr, true);
    nc.setAllowedVestedTarget(treasuryAddr, true);

    // Gateway strategies
    GatewayRegistryV2(gatewayRegAddr).setIsStrategyAllowed(eqStrategyAddr, true, true);
    GatewayRegistryV2(gatewayRegAddr).setIsStrategyAllowed(subStrategyAddr, true, false);
  }

  function _printAddresses() internal view {
    console.log("=== V2 Deployment Complete ===");
    console.log("RZLV Token:           ", tokenAddr);
    console.log("RouterV2:             ", routerAddr);
    console.log("NetworkControllerV2:  ", networkAddr);
    console.log("WorkerRegistrationV2: ", workerRegAddr);
    console.log("StakingV2:            ", stakingAddr);
    console.log("SoftCapV2:            ", softCapAddr);
    console.log("RewardCalculationV2:  ", rewardCalcAddr);
    console.log("DRD V2:               ", distributorAddr);
    console.log("RewardTreasury:       ", treasuryAddr);
    console.log("GatewayRegistryV2:    ", gatewayRegAddr);
    console.log("EqualStrategyV2:      ", eqStrategyAddr);
    console.log("SubequalStrategyV2:   ", subStrategyAddr);
    console.log("AllocationsViewer:    ", viewerAddr);
    console.log("VestingFactoryV2:     ", vestingFactoryAddr);
    console.log("HoldingFactoryV2:     ", holdingFactoryAddr);
  }
}
