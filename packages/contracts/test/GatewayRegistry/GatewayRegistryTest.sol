pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../../src/GatewayRegistry.sol";
import "../../src/SQD.sol";
import "../../src/NetworkController.sol";
import "../../src/WorkerRegistration.sol";
import "../../src/Staking.sol";
import "../BaseTest.sol";

contract GatewayRegistryTest is BaseTest {
  GatewayRegistry gatewayRegistry;
  SQD token;
  RewardCalculation rewardCalc;
  Router router;
  bytes peerId = "peerId";
  address defaultStrategy = address(2137);

  bytes[] myPeers = [bytes("my-peer-1"), "my-peer-2", "my-peer-3"];
  bytes[] notMyPeers = [bytes("some-gateway-1"), "some-gateway-2", "some-gateway-3"];
  string[] metadatas = ["", "some test metadata", ""];
  address[] addresses = [address(0), address(0), address(1)];

  event Staked(address indexed gateway, uint256 amount, uint128 lockStart, uint128 lockedUntil, uint256 cus);

  function setUp() public {
    (token, router) = deployAll();
    rewardCalc = RewardCalculation(address(router.rewardCalculation()));
    gatewayRegistry = new GatewayRegistry(IERC20WithMetadata(address(token)), router);
    gatewayRegistry.setIsStrategyAllowed(defaultStrategy, true, true);
    token.approve(address(gatewayRegistry), type(uint256).max);
    gatewayRegistry.register(peerId, "", address(this));
  }

  function assertStake(uint256, uint256 amount, uint256 lockedUntil) internal {
    GatewayRegistry.Stake memory stake = gatewayRegistry.getStake(address(this));
    assertEq(amount, stake.amount);
    assertEq(lockedUntil, stake.lockEnd);
  }

  function c(bytes memory first) internal pure returns (bytes[] memory) {
    bytes[] memory result = new bytes[](1);
    result[0] = first;
    return result;
  }

  function c(bytes memory first, bytes memory second) internal pure returns (bytes[] memory) {
    return c(c(first), c(second));
  }

  function c(bytes memory first, bytes memory second, bytes memory third) internal pure returns (bytes[] memory) {
    return c(c(first, second), c(third));
  }

  function c(bytes[] memory first, bytes[] memory second) internal pure returns (bytes[] memory) {
    bytes[] memory result = new bytes[](first.length + second.length);
    for (uint256 i = 0; i < first.length; i++) {
      result[i] = first[i];
    }
    for (uint256 i = 0; i < second.length; i++) {
      result[i + first.length] = second[i];
    }
    return result;
  }

  function goToNextEpoch() internal {
    uint128 nextEpoch = router.networkController().nextEpoch();
    vm.roll(nextEpoch);
  }
}
