pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "../../src/GatewayRegistry.sol";
import "../../src/testnet/tSQD.sol";
import "../../src/NetworkController.sol";
import "../../src/WorkerRegistration.sol";
import "../../src/Staking.sol";

contract GatewayRegistryTest is Test {
  GatewayRegistry gatewayRegistry;
  tSQD token;
  RewardCalculation rewardCalc;

  event Staked(address indexed gateway, uint256 amount, uint256 duration, uint256 lockedUntil);

  function setUp() public {
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    token = new tSQD(holders, shares);
    NetworkController nc = new NetworkController(2, 100);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, nc, new Staking(token, nc));
    rewardCalc = new RewardCalculation(workerRegistration, nc);
    gatewayRegistry = new GatewayRegistry(IERC20WithMetadata(address(token)), rewardCalc);
    token.approve(address(gatewayRegistry), type(uint256).max);
  }

  function assertStake(uint256 stakeId, uint256 amount, uint256 lockedUntil) internal {
    (uint256 _amount, uint256 _lockedUntil,) = gatewayRegistry.stakes(address(this), stakeId);
    assertEq(_amount, amount);
    assertEq(_lockedUntil, lockedUntil);
  }
}
