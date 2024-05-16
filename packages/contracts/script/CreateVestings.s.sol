// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/VestingFactory.sol";

struct Entry {
  uint256 Amount;
  uint256 Cliff;
  uint64 End;
  uint64 Start;
  address Wallet;
}

contract CreateVestings is Script {
  using stdJson for string;

  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    address sender = vm.addr(deployerPrivateKey);
    VestingFactory factory = VestingFactory(address(0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca));
    string memory root = vm.projectRoot();
    string memory path = string.concat(root, "/script/mainnet-vestings.json");
    string memory json = vm.readFile(path);
    bytes memory data = json.parseRaw(".");
    Entry[] memory entries = abi.decode(data, (Entry[]));
    vm.startBroadcast(deployerPrivateKey);
    vm.writeFile("vestings.csv", "Wallet,Vesting\n");
    for (uint256 i = 0; i < entries.length; i++) {
      SubsquidVesting vesting = factory.createVesting(
        entries[i].Wallet,
        entries[i].Start,
        entries[i].End - entries[i].Start,
        entries[i].Cliff,
        entries[i].Amount * 1 ether
      );
      vm.writeLine("vestings.csv", string.concat(vm.toString(entries[i].Wallet), ",", vm.toString(address(vesting))));
    }
    vm.stopBroadcast();
  }
}
