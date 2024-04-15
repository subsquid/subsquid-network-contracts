// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "../src/GatewayRegistry.sol";
import "../src/WorkerRegistration.sol";
import "../src/Vesting.sol";
import "../src/Staking.sol";
import "../src/RewardTreasury.sol";

contract UnlockFunds is Script {
  using stdJson for string;

  GatewayRegistry public gatewayReg = GatewayRegistry(0x01D7D0CC06cDdD744a9E06C9bc5249DA6da3e848);
  WorkerRegistration public workerReg = WorkerRegistration(0x7Bf0B1ee9767eAc70A857cEbb24b83115093477F);
  Staking public staking = Staking(0x2B0D385DBC2Eb2946448d1f6be6bfa9Bb53F68C9);
  RewardTreasury public treasury = RewardTreasury(0xBE8518812597C37FA807b1B8A4a3Bb98849E67ab);

  function getVesting(address sender) internal view returns (address payable) {
    string memory root = vm.projectRoot();
    string memory path = string.concat(root, "/script/vestings.json");
    string memory json = vm.readFile(path);
    if (!vm.keyExists(json, string.concat(".", vm.toString(sender)))) {
      console2.log("WARNING: no vesting for ", sender);
      return payable(0);
    }
    address payable vesting = payable(json.readAddress(string.concat(".", vm.toString(sender))));
    console2.log("Vesting for ", vm.toString(sender), " is ", vesting);
    return vesting;
  }

  function claim(address sender, SubsquidVesting vesting) internal {
    console2.log("Claiming pending rewards");
    treasury.claim(IRewardsDistribution(0xcD7560602c6583a1E6dc38df271A3aB5A2023D9b));
    if (address(vesting) != address(0)) {
      treasury.claimFor(IRewardsDistribution(0xcD7560602c6583a1E6dc38df271A3aB5A2023D9b), sender);
    }
  }

  function gatewayUnstake(address sender) internal {
    if (gatewayReg.staked(sender) == 0) {
      return;
    }
    console2.log("Unstaking from gateway registry");
    gatewayReg.unstake();
  }

  function gatewayUnstakeVesting(SubsquidVesting vesting) internal {
    if (address(vesting) == address(0)) {
      return;
    }
    if (gatewayReg.staked(address(vesting)) == 0) {
      return;
    }
    console2.log("Unstaking from gateway registry");
    bytes memory call = abi.encodeWithSelector(GatewayRegistry.unstake.selector);
    vesting.execute(address(gatewayReg), call);
  }

  function retireWorker(address sender) internal {
    uint256[] memory workerIds = workerReg.getOwnedWorkers(sender);
    if (workerIds.length == 0) {
      return;
    }
    for (uint256 i = 0; i < workerIds.length; i++) {
      WorkerRegistration.Worker memory worker = workerReg.getWorker(workerIds[i]);
      if (worker.deregisteredAt == 0) {
        console2.log("Deregistering worker ", workerIds[i]);
        workerReg.deregister(worker.peerId);
        worker = workerReg.getWorker(workerIds[i]);
      }
      uint deregistrationTime = worker.deregisteredAt + workerReg.lockPeriod();
      if (deregistrationTime > 0 && block.number >= worker.deregisteredAt + workerReg.lockPeriod()) {
        console2.log("Withdrawing bond for worker ", workerIds[i]);
        workerReg.withdraw(worker.peerId);
      } else if (block.number < worker.deregisteredAt + workerReg.lockPeriod()) {
        console2.log("Bond is locked for worker", workerIds[i], "until block", deregistrationTime);
      }
    }
  }

  function retireWorkerVesting(SubsquidVesting vesting) internal {
    if (address(vesting) == address(0)) {
      return;
    }
    uint256[] memory workerIds = workerReg.getOwnedWorkers(address(vesting));
    if (workerIds.length == 0) {
      return;
    }
    for (uint256 i = 0; i < workerIds.length; i++) {
      WorkerRegistration.Worker memory worker = workerReg.getWorker(workerIds[i]);
      if (worker.deregisteredAt == 0) {
        console2.log("Deregistering worker ", workerIds[i]);
        bytes memory call = abi.encodeWithSelector(WorkerRegistration.deregister.selector, worker.peerId);
        vesting.execute(address(workerReg), call);
        worker = workerReg.getWorker(workerIds[i]);
      }
      uint deregistrationTime = worker.deregisteredAt + workerReg.lockPeriod();
      if (deregistrationTime > 0 && block.number >= worker.deregisteredAt + workerReg.lockPeriod()) {
        console2.log("Withdrawing bond for worker ", workerIds[i]);
        bytes memory call = abi.encodeWithSelector(WorkerRegistration.withdraw.selector, worker.peerId);
        vesting.execute(address(workerReg), call);
      } else if (block.number < worker.deregisteredAt + workerReg.lockPeriod()) {
        console2.log("Bond is locked for worker", workerIds[i], "until block", deregistrationTime);
        console.log("Rerun this script later to withdraw the bond");
      }
    }
  }

  function unstake(address sender) internal {
    uint256[] memory delegations = staking.delegates(sender);
    if (delegations.length == 0) {
      return;
    }
    console2.log("Withdrawing delegations for", delegations.length, "workers");
    for (uint256 i = 0; i < delegations.length; i++) {
      (uint256 amount, uint256 withdrawAllowed) = staking.getDeposit(sender, delegations[i]);
      if (withdrawAllowed <= block.number) {
        staking.withdraw(delegations[i], amount);
      } else {
        console2.log("Undelegation is not allowed for worker", delegations[i]);
      }
    }
  }

  function unstakeVesting(SubsquidVesting vesting) internal {
    uint256[] memory delegations = staking.delegates(address(vesting));
    if (delegations.length == 0) {
      return;
    }
    console2.log("Withdrawing delegations for", delegations.length, "workers");
    for (uint256 i = 0; i < delegations.length; i++) {
      (uint256 amount, uint256 withdrawAllowed) = staking.getDeposit(address(vesting), delegations[i]);
      if (withdrawAllowed <= block.number) {
        bytes memory call = abi.encodeWithSelector(Staking.withdraw.selector, delegations[i], amount);
        vesting.execute(address(staking), call);
      } else {
        console2.log("Undelegation is not allowed for worker", delegations[i]);
      }
    }
  }

  function run() public {
    uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
    if (deployerPrivateKey == 0) {
      console2.log("PRIVATE_KEY env var is required");
      return;
    }
    vm.startBroadcast(deployerPrivateKey);
    address sender = vm.addr(deployerPrivateKey);
    SubsquidVesting vesting = SubsquidVesting(getVesting(sender));
    claim(sender, vesting);
    gatewayUnstake(sender);
    gatewayUnstakeVesting(vesting);
    retireWorker(sender);
    retireWorkerVesting(vesting);
    unstake(sender);
    unstakeVesting(vesting);
    vm.stopBroadcast();
  }
}
