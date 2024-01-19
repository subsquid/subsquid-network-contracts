pragma solidity 0.8.20;

import "./GatewayRegistryTest.sol";

contract GatewayRegistryAllocateTest is GatewayRegistryTest {
  function gasUsageForNWorkers(uint256 n) internal {
    uint256[] memory workerIds = new uint256[](n);
    uint256[] memory cus = new uint256[](n);
    for (uint256 i = 0; i < n; i++) {
      workerIds[i] = i + 1;
      cus[i] = 10;
    }

    vm.mockCall(
      address(gatewayRegistry.router().workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.nextWorkerId.selector),
      abi.encode(100000)
    );
    uint256 gasBefore = gasleft();
    gatewayRegistry.allocateComputationUnits(workerIds, cus);
    uint256 gasAfter = gasleft();
    uint256 gasUsed = gasBefore - gasAfter;
    emit log_named_uint("gasUsed", gasUsed);
  }

  function test_AllocateCUsGasUsageFor1000Workers() public {
    gatewayRegistry.stake(10000 ether, 2000);
    gasUsageForNWorkers(1000);
  }
}
