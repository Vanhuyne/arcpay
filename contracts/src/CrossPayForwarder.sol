// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool);
}

interface IPaymentRouter {
    function pay(bytes32 invoiceId, address merchant, uint256 amount) external payable;
}

/// @title CrossPayForwarder
/// @notice Turns a CCTP v2 mint into an invoice payment in one transaction.
/// @dev The CCTP burn on the source chain sets mintRecipient = this contract and
///      destinationCaller = this contract, so the message can only be executed
///      here. `mintAndPay` is restricted to the relayer so nobody can execute it
///      with a fake merchant. On Arc the mint credits this contract's NATIVE
///      balance (18-decimal); forwarding the balance delta means this contract
///      never converts between USDC's 6- and 18-decimal representations.
contract CrossPayForwarder {
    IMessageTransmitterV2 public immutable messageTransmitter;
    IPaymentRouter public immutable router;
    address public immutable relayer;

    error OnlyRelayer();
    error ReceiveFailed();
    error NothingMinted();
    error RescueFailed();

    constructor(address transmitter, address router_, address relayer_) {
        messageTransmitter = IMessageTransmitterV2(transmitter);
        router = IPaymentRouter(router_);
        relayer = relayer_;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    /// @dev The mint may arrive as a plain native credit or as a value call.
    receive() external payable {}

    /// @notice Execute a CCTP message (minting native USDC here) and forward the
    ///         entire minted amount to the router as payment for `invoiceId`.
    ///         Atomic: if `pay` reverts, the message stays unconsumed.
    function mintAndPay(
        bytes calldata message,
        bytes calldata attestation,
        bytes32 invoiceId,
        address merchant
    ) external onlyRelayer {
        uint256 delta = _mint(message, attestation);
        router.pay{value: delta}(invoiceId, merchant, delta);
    }

    /// @notice Escape hatch for a burn that must never be paid (wrong amount,
    ///         invoice already settled): mint and refund to `to` — typically the
    ///         burn's depositor, whose EOA address is the same on Arc.
    function rescue(bytes calldata message, bytes calldata attestation, address to)
        external
        onlyRelayer
    {
        uint256 delta = _mint(message, attestation);
        (bool sent,) = to.call{value: delta}("");
        if (!sent) revert RescueFailed();
    }

    function _mint(bytes calldata message, bytes calldata attestation)
        private
        returns (uint256 delta)
    {
        uint256 balanceBefore = address(this).balance;
        bool ok = messageTransmitter.receiveMessage(message, attestation);
        if (!ok) revert ReceiveFailed();
        delta = address(this).balance - balanceBefore;
        if (delta == 0) revert NothingMinted();
    }
}
