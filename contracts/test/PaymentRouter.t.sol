// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// @dev A merchant that tries to re-enter the router when it receives funds.
contract ReentrantMerchant {
    PaymentRouter private immutable router;
    bytes32 private immutable invoiceId;
    uint256 private immutable amount;
    bool private entered;

    constructor(PaymentRouter r, bytes32 id, uint256 amt) {
        router = r;
        invoiceId = id;
        amount = amt;
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            router.pay{value: amount}(invoiceId, address(this), amount);
        }
    }
}

contract PaymentRouterTest is Test {
    PaymentRouter private router;

    address private merchant = makeAddr("merchant");
    address private payer = makeAddr("payer");
    address private griefer = makeAddr("griefer");

    bytes32 private constant INVOICE = bytes32(uint256(0xA11CE));
    uint256 private constant AMOUNT = 500e18; // 500 USDC, native 18-decimal

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 timestamp
    );

    function setUp() public {
        router = new PaymentRouter();
        vm.deal(payer, 1000e18);
        vm.deal(griefer, 1000e18);
    }

    function test_ForwardsFundsAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit InvoicePaid(INVOICE, merchant, payer, AMOUNT, uint64(block.timestamp));

        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);

        assertEq(merchant.balance, AMOUNT, "merchant received funds");
        assertEq(address(router).balance, 0, "router holds nothing");
    }

    function test_RevertWhen_ValueDoesNotMatchAmount() public {
        vm.prank(payer);
        vm.expectRevert(PaymentRouter.AmountMismatch.selector);
        router.pay{value: AMOUNT - 1}(INVOICE, merchant, AMOUNT);
    }

    function test_RevertWhen_MerchantIsZeroAddress() public {
        vm.prank(payer);
        vm.expectRevert(PaymentRouter.InvalidMerchant.selector);
        router.pay{value: AMOUNT}(INVOICE, address(0), AMOUNT);
    }

    function test_RevertWhen_SameTripleIsReplayed() public {
        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);

        vm.prank(payer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);
    }

    /// The single most important test in this repo.
    /// A griefer paying a dust amount against our invoiceId must NOT be able to
    /// mark it settled and thereby block the real customer's payment.
    function test_GrieferCannotBlockRealPayment() public {
        uint256 dust = 0.01e18;

        vm.prank(griefer);
        router.pay{value: dust}(INVOICE, griefer, dust); // different (id, merchant, amount) key

        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT); // must still succeed

        assertEq(merchant.balance, AMOUNT, "real payment went through untouched");
    }

    function test_RevertWhen_MerchantReentersRouter() public {
        ReentrantMerchant evil = new ReentrantMerchant(router, INVOICE, AMOUNT);
        vm.deal(payer, 2 * AMOUNT);

        vm.prank(payer);
        vm.expectRevert(PaymentRouter.ForwardFailed.selector);
        router.pay{value: AMOUNT}(INVOICE, address(evil), AMOUNT);

        assertEq(address(evil).balance, 0, "reentrancy extracted nothing");
    }
}
