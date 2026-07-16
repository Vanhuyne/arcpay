// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {CrossPayForwarder} from "../src/CrossPayForwarder.sol";

/// @dev Stands in for MessageTransmitterV2: "minting" native USDC on Arc is
///      simulated by sending native value to the caller. On the real chain the
///      mint credits the recipient's native balance; the value transfer here
///      additionally exercises the forwarder's receive() path.
contract MockTransmitter {
    uint256 public mintAmount;

    constructor() payable {}

    function setMintAmount(uint256 amount) external {
        mintAmount = amount;
    }

    function receiveMessage(bytes calldata, bytes calldata) external returns (bool) {
        (bool ok,) = msg.sender.call{value: mintAmount}("");
        require(ok, "mint transfer failed");
        return true;
    }
}

contract CrossPayForwarderTest is Test {
    PaymentRouter private router;
    MockTransmitter private transmitter;
    CrossPayForwarder private forwarder;

    address private merchant = makeAddr("merchant");
    address private relayer = makeAddr("relayer");
    address private stranger = makeAddr("stranger");
    address private customer = makeAddr("customer");

    bytes32 private constant INVOICE = bytes32(uint256(0xB0B));
    uint256 private constant AMOUNT = 25e18; // 25 USDC, native 18-decimal

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 timestamp
    );

    function setUp() public {
        router = new PaymentRouter();
        transmitter = new MockTransmitter{value: 1000e18}();
        forwarder = new CrossPayForwarder(address(transmitter), address(router), relayer);
        transmitter.setMintAmount(AMOUNT);
    }

    function test_MintAndPaySettlesInvoice() public {
        // The payer seen by the router is the forwarder itself.
        vm.expectEmit(true, true, true, true);
        emit InvoicePaid(INVOICE, merchant, address(forwarder), AMOUNT, uint64(block.timestamp));

        vm.prank(relayer);
        forwarder.mintAndPay(hex"aa", hex"bb", INVOICE, merchant);

        assertEq(merchant.balance, AMOUNT, "merchant received the mint");
        assertEq(address(forwarder).balance, 0, "forwarder holds nothing");
    }

    function test_RevertWhen_CallerIsNotRelayer() public {
        vm.prank(stranger);
        vm.expectRevert(CrossPayForwarder.OnlyRelayer.selector);
        forwarder.mintAndPay(hex"aa", hex"bb", INVOICE, merchant);
    }

    function test_RevertWhen_NothingMinted() public {
        transmitter.setMintAmount(0);
        vm.prank(relayer);
        vm.expectRevert(CrossPayForwarder.NothingMinted.selector);
        forwarder.mintAndPay(hex"aa", hex"bb", INVOICE, merchant);
    }

    /// If the invoice triple is already settled the router reverts, the whole
    /// mintAndPay reverts, and (on the real chain) the CCTP message stays
    /// unconsumed for rescue(). This test proves atomicity: no funds strand.
    function test_AtomicWhenPayReverts() public {
        address directPayer = makeAddr("directPayer");
        vm.deal(directPayer, AMOUNT);
        vm.prank(directPayer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);

        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        forwarder.mintAndPay(hex"aa", hex"bb", INVOICE, merchant);

        assertEq(address(forwarder).balance, 0, "revert left nothing behind");
    }

    function test_RescueSendsMintToRecipient() public {
        vm.prank(relayer);
        forwarder.rescue(hex"aa", hex"bb", customer);

        assertEq(customer.balance, AMOUNT, "customer refunded");
        assertEq(address(forwarder).balance, 0, "forwarder holds nothing");
    }

    function test_RevertWhen_RescueCallerIsNotRelayer() public {
        vm.prank(stranger);
        vm.expectRevert(CrossPayForwarder.OnlyRelayer.selector);
        forwarder.rescue(hex"aa", hex"bb", customer);
    }
}
