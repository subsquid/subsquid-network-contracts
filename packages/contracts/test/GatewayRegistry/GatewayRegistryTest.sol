pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "../../src/GatewayRegistry.sol";
import "../../src/testnet/tSQD.sol";
import "../../src/NetworkController.sol";
import "../../src/WorkerRegistration.sol";
import "../../src/Staking.sol";
import "../BaseTest.sol";

contract GatewayRegistryTest is BaseTest {
  GatewayRegistry gatewayRegistry;
  tSQD token;
  RewardCalculation rewardCalc;

  event Staked(address indexed gateway, uint256 amount, uint256 duration, uint256 lockedUntil);

  function setUp() public {
    (tSQD _token, Router router) = deployAll();
    token = _token;
    rewardCalc = RewardCalculation(address(router.rewardCalculation()));
    gatewayRegistry = new GatewayRegistry(IERC20WithMetadata(address(token)), router);
    token.approve(address(gatewayRegistry), type(uint256).max);
  }

  function assertStake(uint256 stakeId, uint256 amount, uint256 lockedUntil) internal {
    (uint256 _amount, uint256 _lockedUntil,) = gatewayRegistry.stakes(address(this), stakeId);
    assertEq(_amount, amount);
    assertEq(_lockedUntil, lockedUntil);
  }
}
