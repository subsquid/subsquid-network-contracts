pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../../src/GatewayRegistry.sol";
import "../../src/tSQD.sol";
import "../../src/NetworkController.sol";
import "../../src/WorkerRegistration.sol";
import "../../src/Staking.sol";
import "../BaseTest.sol";

contract GatewayRegistryTest is BaseTest {
  GatewayRegistry gatewayRegistry;
  tSQD token;
  RewardCalculation rewardCalc;
  Router router;
  bytes peerId = "peerId";

  event Staked(address indexed gateway, uint256 amount, uint128 duration, uint128 lockedUntil, uint256 cus);

  function setUp() public {
    (token, router) = deployAll();
    rewardCalc = RewardCalculation(address(router.rewardCalculation()));
    gatewayRegistry = new GatewayRegistry(IERC20WithMetadata(address(token)), router);
    token.approve(address(gatewayRegistry), type(uint256).max);
    gatewayRegistry.register(peerId);
  }

  function assertStake(uint256 stakeId, uint256 amount, uint256 lockedUntil) internal {
    GatewayRegistry.Stake memory stakes = gatewayRegistry.getStakes(peerId, stakeId);
    assertEq(amount, stakes.amount);
    assertEq(lockedUntil, stakes.lockedUntil);
  }
}
