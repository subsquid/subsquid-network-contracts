// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct WorkerCreator {
  string name;
  address payable wallet;
  uint workerCount;
}

uint constant ETHER_AMOUNT = 0.005 ether;
uint constant BOND_AMOUNT = 100_000 ether;

contract Bounty is Script {
  using stdJson for string;

  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    address sender = vm.addr(deployerPrivateKey);
    IERC20 token = IERC20(address(0x0D3934b08AdB5fbe30F48B3A18ba636460655B7E));
    require(token.balanceOf(sender) > 0, "No tSQD for the sender");
    string memory root = vm.projectRoot();
    string memory path = string.concat(root, "/script/workersSurvey.json");
    string memory json = vm.readFile(path);
    bytes memory data = json.parseRaw(".");
    WorkerCreator[] memory workers = abi.decode(data, (WorkerCreator[]));
    vm.startBroadcast(deployerPrivateKey);
    for (uint i = 0; i<workers.length; i++) {
      token.transfer(workers[i].wallet, BOND_AMOUNT * workers[i].workerCount);
      workers[i].wallet.transfer(ETHER_AMOUNT * workers[i].workerCount);
    }
    vm.stopBroadcast();
  }
}
