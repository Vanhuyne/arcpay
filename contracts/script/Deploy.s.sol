// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        PaymentRouter router = new PaymentRouter();
        vm.stopBroadcast();
        console.log("PaymentRouter deployed at:", address(router));
    }
}
