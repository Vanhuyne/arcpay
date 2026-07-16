// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CrossPayForwarder} from "../src/CrossPayForwarder.sol";

contract DeployForwarder is Script {
    // MessageTransmitterV2 on Arc Testnet (same address on every CCTP v2 chain).
    address private constant TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;

    function run() external {
        address router = vm.envAddress("ROUTER_ADDRESS");
        address relayer = vm.envAddress("RELAYER_ADDRESS");

        vm.startBroadcast();
        CrossPayForwarder forwarder = new CrossPayForwarder(TRANSMITTER, router, relayer);
        vm.stopBroadcast();

        console.log("CrossPayForwarder deployed at:", address(forwarder));
    }
}
