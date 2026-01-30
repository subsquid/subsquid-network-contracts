// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";

contract DeployFeeRouterV2 is Script {
    function run() external {
        vm.startBroadcast();

        FeeRouterModuleV2 router = new FeeRouterModuleV2();
        console.log("FeeRouterModuleV2 deployed at:", address(router));

        vm.stopBroadcast();
    }
}
