// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/VestingFactory.sol";

struct WorkerCreator {
  address payable wallet;
  uint256 workerCount;
}

uint256 constant ETHER_AMOUNT = 0.005 ether;
uint256 constant BOND_AMOUNT = 100_000 ether;

contract Bounty is Script {
  using stdJson for string;

  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    address sender = vm.addr(deployerPrivateKey);
    IERC20 token = IERC20(address(0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c));
    VestingFactory factory = VestingFactory(address(0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca));
    require(token.balanceOf(sender) > 0, "No SQD for the sender");
    string memory root = vm.projectRoot();
    string memory path = string.concat(root, "/script/workersSurvey.json");
    string memory json = vm.readFile(path);
    bytes memory data = json.parseRaw(".");
    WorkerCreator[] memory workers = abi.decode(data, (WorkerCreator[]));
    vm.startBroadcast(deployerPrivateKey);
    for (uint256 i = 0; i < workers.length; i++) {
      uint256 amount = BOND_AMOUNT * workers[i].workerCount;
      SubsquidVesting vesting = factory.createVesting(
        workers[i].wallet,
        1705273200, // Jan 15, 2024
        60 days,
        0,
        amount
      );
      token.transfer(address(vesting), BOND_AMOUNT * workers[i].workerCount);
    }
    vm.stopBroadcast();
  }
}
