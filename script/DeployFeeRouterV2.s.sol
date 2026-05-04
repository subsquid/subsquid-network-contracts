// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";

contract DeployFeeRouterV2 is Script {
    // Arbitrum One mainnet
    address public constant PANCAKE_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address public constant SQD = 0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1;
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    function run() external {
        vm.startBroadcast();

        FeeRouterModuleV2 router = new FeeRouterModuleV2(PANCAKE_V3_ROUTER, PANCAKE_V3_FACTORY, SQD, WETH);
        console.log("FeeRouterModuleV2 deployed at:", address(router));

        vm.stopBroadcast();
    }
}
