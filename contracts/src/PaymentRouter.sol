// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PaymentRouter
/// @notice Routes native USDC payments on Arc and emits events for reconciliation.
/// @dev The contract never holds funds: whatever arrives is forwarded to the merchant
///      within the same transaction. No owner, no upgrade path, no withdrawal function.
contract PaymentRouter {
    /// @dev `amount` is denominated in 18 decimals (native USDC / msg.value).
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 timestamp
    );

    /// @dev key = keccak256(invoiceId, merchant, amount).
    ///      Keyed on all three fields, not on invoiceId alone: otherwise anyone could
    ///      settle someone else's invoice for dust and permanently block the real payment.
    mapping(bytes32 => bool) public settled;

    error AlreadySettled();
    error AmountMismatch();
    error InvalidMerchant();
    error ForwardFailed();

    function pay(bytes32 invoiceId, address merchant, uint256 amount) external payable {
        if (merchant == address(0)) revert InvalidMerchant();
        if (msg.value != amount) revert AmountMismatch();

        bytes32 key = keccak256(abi.encode(invoiceId, merchant, amount));
        if (settled[key]) revert AlreadySettled();
        settled[key] = true; // effects before interaction: no reentrancy

        (bool ok,) = merchant.call{value: amount}("");
        if (!ok) revert ForwardFailed();

        emit InvoicePaid(invoiceId, merchant, msg.sender, amount, uint64(block.timestamp));
    }
}
