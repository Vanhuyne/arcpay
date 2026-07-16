# Crosschain CCTP Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer holding USDC on Base Sepolia pays an ArcPay invoice from the existing checkout page, signing only two transactions on Base; the server relays attestation → mint → pay on Arc.

**Architecture:** A new `CrossPayForwarder` contract on Arc receives the CCTP v2 mint and forwards it to the deployed `PaymentRouter` in the same transaction, so `InvoicePaid` fires exactly as in the direct flow and `web/lib/verify.ts` and the POS screen stay untouched. The web side adds a `bridge_payments` state machine (`burn_confirmed → attested → paid | failed`) advanced one non-blocking step per poll, with the existing cron as fallback.

**Tech Stack:** Foundry (Solidity 0.8.24), CCTP v2 (TokenMessengerV2 / MessageTransmitterV2), Circle Iris attestation API (sandbox), Next.js 16 + wagmi 3 + viem 2, drizzle + Neon Postgres, vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-crosschain-cctp-checkout-design.md`

## Global Constraints

- Native (msg.value, gas) is 18-decimal; DB, API, UI are 6-decimal. Only `web/lib/usdc.ts` converts. The forwarder deliberately needs **no** conversion: it forwards its native balance delta.
- The CCTP burn amount on Base Sepolia is **6-decimal** (standard ERC-20 USDC) — `invoice.amount6` is used directly. This is not a conversion.
- Never trust the client: a browser-supplied `burnTxHash` is a hint; the server re-reads the Base Sepolia receipt before any state change. `web/lib/verify.ts` stays the single verifier for Arc payments and must not be modified.
- The merchant never signs a tx and never pays gas. The new relayer key belongs to the operator, not the merchant.
- Invoice `expired` stays derived, never stored; a payment that lands late still marks the invoice paid (`wasLate`).
- English only (code, comments, commits). Conventional Commits. Commit after each task.
- tsconfig target is ES2020+ (bigint literals). `pnpm next build` is what typechecks CI-style; vitest alone won't catch type errors.
- `web/` is Next.js 16 — read `web/AGENTS.md` and `node_modules/next/dist/docs/` before touching Next code.
- vitest loads `.env.local` via `loadEnv` in `web/vitest.config.ts`; new `NEXT_PUBLIC_*`/server env vars are visible under test once added to `.env.local`.
- Run web commands from `web/` (`cd web` explicitly — Bash cwd persists), contract commands from `contracts/`.

## Verified CCTP v2 facts (do not re-derive)

| Item | Value |
| --- | --- |
| TokenMessengerV2 (same address on Arc Testnet AND Base Sepolia) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 (same address on both) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Arc Testnet CCTP domain | `26` |
| Base Sepolia CCTP domain | `6` |
| USDC on Base Sepolia (6-decimal ERC-20) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| USDC ERC-20 view on Arc | `0x3600000000000000000000000000000000000000` |
| `depositForBurn` v2 | `depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)` |
| `DepositForBurn` v2 event | `DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)` — no nonce field in v2 |
| `receiveMessage` | `receiveMessage(bytes message, bytes attestation)` on MessageTransmitterV2 |
| Standard transfer | `minFinalityThreshold = 2000`, `maxFee = 0` → minted amount == burned amount |
| Attestation API (sandbox) | `GET https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}?transactionHash={hash}` → `{ messages: [{ message, attestation, status: "complete" \| "pending_confirmations", ... }] }`; 404 until indexed |

## File Structure

```
contracts/src/CrossPayForwarder.sol        # new: CCTP mint -> router.pay, atomic
contracts/test/CrossPayForwarder.t.sol     # new: mock transmitter + real router
contracts/script/DeployForwarder.s.sol     # new: deploy script
web/lib/forwarder.ts                       # new: forwarder ABI + address (mirrors router.ts)
web/lib/cctp.ts                            # new: chain/domain config, burn verifier, attestation client
web/lib/relayer.ts                         # new: relayer wallet, sendMintAndPay
web/lib/bridge.ts                          # new: bridge_payments queries + advance state machine
web/db/schema.ts                           # modify: add bridgePayments table
web/lib/dto.ts                             # modify: add PublicBridge
web/app/api/invoices/[id]/bridge/route.ts  # new: POST register burn, GET poll/advance
web/app/api/cron/reconcile/route.ts        # modify: also advance stale bridge payments
web/lib/wagmi.ts                           # modify: add baseSepolia
web/app/pay/[id]/bridge-checkout.tsx       # new: Base-Sepolia payment flow + progress stepper
web/app/pay/[id]/checkout.tsx              # modify: source selector (Arc | Base Sepolia)
web/test/cctp.test.ts                      # new
web/test/bridge.test.ts                    # new
web/test/forwarder.test.ts                 # new
web/.env.example                           # modify: new env keys
CLAUDE.md                                  # modify: new invariant notes + gotchas
```

---

## Task 1: `CrossPayForwarder` contract

**Files:**
- Create: `contracts/src/CrossPayForwarder.sol`
- Test: `contracts/test/CrossPayForwarder.t.sol`

**Interfaces:**
- Consumes: deployed `PaymentRouter` semantics — `pay(bytes32 invoiceId, address merchant, uint256 amount)` requires `msg.value == amount`, reverts `AlreadySettled` on a repeated `(invoiceId, merchant, amount)` triple.
- Produces: `mintAndPay(bytes message, bytes attestation, bytes32 invoiceId, address merchant)` and `rescue(bytes message, bytes attestation, address to)`, both `onlyRelayer`. Constructor: `(address transmitter, address router_, address relayer_)`.

- [ ] **Step 1: Write the failing tests**

Create `contracts/test/CrossPayForwarder.t.sol`:

```solidity
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /Users/vanhuy/Desktop/arc/contracts && forge test --match-contract CrossPayForwarderTest
```

Expected: compilation error — `CrossPayForwarder.sol` does not exist.

- [ ] **Step 3: Implement `contracts/src/CrossPayForwarder.sol`**

```solidity
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd /Users/vanhuy/Desktop/arc/contracts && forge test
```

Expected: all tests pass (7 existing PaymentRouter tests + 6 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add contracts/src/CrossPayForwarder.sol contracts/test/CrossPayForwarder.t.sol && git commit -m "feat: add CrossPayForwarder — CCTP mint to invoice payment, atomic"
```

---

## Task 2: Deploy the forwarder and bind `web/lib/forwarder.ts`

**Files:**
- Create: `contracts/script/DeployForwarder.s.sol`
- Create: `web/lib/forwarder.ts`
- Test: `web/test/forwarder.test.ts`
- Modify: `web/.env.example`, `web/.env.local` (local only, never committed)

**Interfaces:**
- Consumes: `CrossPayForwarder` constructor `(transmitter, router, relayer)` from Task 1.
- Produces: `FORWARDER_ABI` (mintAndPay, rescue), `FORWARDER_ADDRESS: Address` (from `NEXT_PUBLIC_FORWARDER_ADDRESS`), and env keys `RELAYER_PRIVATE_KEY`, `NEXT_PUBLIC_FORWARDER_ADDRESS`.

- [ ] **Step 1: Create the relayer wallet**

```bash
cd /Users/vanhuy/Desktop/arc/contracts && cast wallet new
```

Record the address and private key. Fund the **relayer address** with testnet USDC from https://faucet.circle.com (select Arc Testnet) — it pays gas for `mintAndPay`, a few USDC is plenty.

- [ ] **Step 2: Write the deploy script**

Create `contracts/script/DeployForwarder.s.sol`:

```solidity
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
```

- [ ] **Step 3: Deploy to Arc Testnet**

Uses the existing deployer key in `contracts/.env` (same one that deployed the router):

```bash
cd /Users/vanhuy/Desktop/arc/contracts && source .env && \
ROUTER_ADDRESS=0x8F560cA651B89FefdcC3273960f9b56BF69EdEaE \
RELAYER_ADDRESS=<relayer address from Step 1> \
forge script script/DeployForwarder.s.sol --rpc-url arc_testnet --broadcast --private-key $PRIVATE_KEY
```

Expected: `CrossPayForwarder deployed at: 0x…`. Verify on https://testnet.arcscan.app.

- [ ] **Step 4: Record the env keys**

Append to `web/.env.example` (placeholders only — real values go in `web/.env.local`, which is gitignored):

```bash
NEXT_PUBLIC_FORWARDER_ADDRESS=

# Ops key that relays CCTP mints on Arc. Holds a little USDC for gas.
# NOT the merchant and NOT the contract deployer.
RELAYER_PRIVATE_KEY=
```

Set both real values in `web/.env.local`.

- [ ] **Step 5: Write the failing test**

Create `web/test/forwarder.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { FORWARDER_ABI, FORWARDER_ADDRESS } from '@/lib/forwarder';

describe('forwarder binding', () => {
  it('exposes a deployed address', () => {
    expect(FORWARDER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('carries mintAndPay and rescue in the ABI', () => {
    const names = FORWARDER_ABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).toContain('mintAndPay');
    expect(names).toContain('rescue');
  });
});
```

- [ ] **Step 6: Run the test and confirm it fails**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/forwarder.test.ts
```

Expected: FAIL — cannot resolve `@/lib/forwarder`.

- [ ] **Step 7: Implement `web/lib/forwarder.ts`**

Mirrors `web/lib/router.ts`:

```typescript
import type { Address } from 'viem';

export const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'mintAndPay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'merchant', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rescue',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export const FORWARDER_ADDRESS = process.env.NEXT_PUBLIC_FORWARDER_ADDRESS as Address;

if (!FORWARDER_ADDRESS) {
  throw new Error('NEXT_PUBLIC_FORWARDER_ADDRESS is not set — deploy CrossPayForwarder first');
}
```

- [ ] **Step 8: Run the test and confirm it passes**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/forwarder.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add contracts/script/DeployForwarder.s.sol web/lib/forwarder.ts web/test/forwarder.test.ts web/.env.example && git commit -m "feat: deploy CrossPayForwarder to Arc Testnet and bind its ABI"
```

---

## Task 3: `web/lib/cctp.ts` — source chains, burn verifier, attestation client

**Files:**
- Create: `web/lib/cctp.ts`
- Test: `web/test/cctp.test.ts`

**Interfaces:**
- Consumes: `FORWARDER_ADDRESS` from Task 2; `Invoice` from `@/db/schema`.
- Produces (used by Tasks 4–6):
  - `ARC_DOMAIN = 26`, `STANDARD_FINALITY = 2000`, `TOKEN_MESSENGER`, `MESSAGE_TRANSMITTER` address constants
  - `SOURCE_CHAINS: Record<number, SourceChain>` with entry `6` (Base Sepolia); `SourceChain = { domain, chain, usdc, rpcUrl }`
  - `TOKEN_MESSENGER_ABI` (depositForBurn + DepositForBurn event), `ERC20_ABI` (approve, balanceOf)
  - `sourcePublicClient(domain: number): PublicClient`
  - `verifyBurn(invoice: Invoice, sourceDomain: number, burnTxHash: Hex, client?: PublicClient): Promise<VerifyBurnResult>` where `VerifyBurnResult = { ok: true; depositor: Address } | { ok: false; reason: BurnFailure }`
  - `fetchAttestation(sourceDomain: number, burnTxHash: Hex, fetchFn?: typeof fetch): Promise<Attestation>` where `Attestation = { status: 'pending' } | { status: 'complete'; message: Hex; attestation: Hex }`

- [ ] **Step 1: Write the failing tests**

Create `web/test/cctp.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { encodeEventLog, pad, type Hex, type PublicClient } from 'viem';
import {
  ARC_DOMAIN,
  fetchAttestation,
  SOURCE_CHAINS,
  TOKEN_MESSENGER,
  TOKEN_MESSENGER_ABI,
  verifyBurn,
} from '@/lib/cctp';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import type { Invoice } from '@/db/schema';

const BASE_DOMAIN = 6;
const BURN_TX = ('0x' + 'ab'.repeat(32)) as Hex;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as const;

const invoice: Invoice = {
  id: '0x' + 'cd'.repeat(32),
  merchant: '0x2222222222222222222222222222222222222222',
  amount6: 25_000_000n, // 25 USDC
  description: 'test',
  status: 'pending',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 900_000),
  txHash: null,
  payer: null,
  blockNumber: null,
  paidAt: null,
  gasFee: null,
  wasLate: false,
};

/** A synthetic Base Sepolia receipt carrying one DepositForBurn log. */
function receiptWithBurn(overrides: Partial<Record<'amount' | 'mintRecipient' | 'destinationDomain' | 'destinationCaller' | 'burnToken', unknown>> = {}) {
  const log = encodeEventLog({
    abi: TOKEN_MESSENGER_ABI,
    eventName: 'DepositForBurn',
    args: {
      burnToken: (overrides.burnToken ?? SOURCE_CHAINS[BASE_DOMAIN].usdc) as `0x${string}`,
      amount: (overrides.amount ?? invoice.amount6) as bigint,
      depositor: DEPOSITOR,
      mintRecipient: (overrides.mintRecipient ?? pad(FORWARDER_ADDRESS, { size: 32 })) as Hex,
      destinationDomain: (overrides.destinationDomain ?? ARC_DOMAIN) as number,
      destinationTokenMessenger: pad(TOKEN_MESSENGER, { size: 32 }),
      destinationCaller: (overrides.destinationCaller ?? pad(FORWARDER_ADDRESS, { size: 32 })) as Hex,
      maxFee: 0n,
      minFinalityThreshold: 2000,
      hookData: '0x',
    },
  });
  return {
    status: 'success' as const,
    logs: [{ ...log, address: TOKEN_MESSENGER }],
  };
}

function mockClient(receipt: unknown): PublicClient {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  } as unknown as PublicClient;
}

describe('verifyBurn', () => {
  it('accepts a burn matching invoice amount, forwarder recipient, and Arc domain', async () => {
    const result = await verifyBurn(invoice, BASE_DOMAIN, BURN_TX, mockClient(receiptWithBurn()));
    expect(result).toEqual({ ok: true, depositor: DEPOSITOR.toLowerCase() });
  });

  it('rejects an unknown source domain', async () => {
    const result = await verifyBurn(invoice, 999, BURN_TX, mockClient(receiptWithBurn()));
    expect(result).toEqual({ ok: false, reason: 'unknown_domain' });
  });

  it('rejects a reverted burn tx', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient({ status: 'reverted', logs: [] }),
    );
    expect(result).toEqual({ ok: false, reason: 'tx_reverted' });
  });

  it('rejects a receipt with no DepositForBurn from the TokenMessenger', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient({ status: 'success', logs: [] }),
    );
    expect(result).toEqual({ ok: false, reason: 'no_burn_log' });
  });

  it('rejects a burn whose amount does not match the invoice', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ amount: 24_000_000n })),
    );
    expect(result).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('rejects a burn minting to someone other than the forwarder', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ mintRecipient: pad(DEPOSITOR, { size: 32 }) })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_recipient' });
  });

  it('rejects a burn aimed at a different destination domain', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ destinationDomain: 0 })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_destination' });
  });

  it('rejects a burn of a token other than USDC', async () => {
    // A non-USDC burn (e.g. EURC) would mint an ERC-20 the forwarder cannot
    // forward as native value — it must never reach the relay.
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ burnToken: '0x3333333333333333333333333333333333333333' })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_token' });
  });

  it('rejects a missing receipt', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not found')),
    } as unknown as PublicClient;
    const result = await verifyBurn(invoice, BASE_DOMAIN, BURN_TX, client);
    expect(result).toEqual({ ok: false, reason: 'no_receipt' });
  });
});

describe('fetchAttestation', () => {
  it('returns pending while Iris has not indexed the burn (404)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'pending' });
  });

  it('returns pending while confirmations are outstanding', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: 'pending_confirmations', attestation: null }] }),
    });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'pending' });
  });

  it('returns the message and attestation once complete', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ status: 'complete', message: '0x1234', attestation: '0x5678' }],
      }),
    });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'complete', message: '0x1234', attestation: '0x5678' });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/${BASE_DOMAIN}?transactionHash=${BURN_TX}`,
    );
  });

  it('throws on a 5xx so the caller retries later', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/cctp.test.ts
```

Expected: FAIL — cannot resolve `@/lib/cctp`.

- [ ] **Step 3: Implement `web/lib/cctp.ts`**

```typescript
import {
  createPublicClient,
  decodeEventLog,
  http,
  pad,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import type { Invoice } from '@/db/schema';

export { baseSepolia };

/** CCTP v2 is deployed at the same addresses on every EVM chain. */
export const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
export const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;

export const ARC_DOMAIN = 26;
/** Standard transfer: minted amount equals burned amount, no fast-transfer fee. */
export const STANDARD_FINALITY = 2000;

export type SourceChain = {
  domain: number;
  chain: typeof baseSepolia;
  usdc: Address;
  rpcUrl: string;
};

/** Adding a source chain later = adding one entry here. */
export const SOURCE_CHAINS: Record<number, SourceChain> = {
  6: {
    domain: 6,
    chain: baseSepolia,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  },
};

export const TOKEN_MESSENGER_ABI = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'burnToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
      { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
      { name: 'hookData', type: 'bytes', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export function sourcePublicClient(domain: number): PublicClient {
  const source = SOURCE_CHAINS[domain];
  if (!source) throw new Error(`Unknown CCTP source domain: ${domain}`);
  return createPublicClient({ chain: source.chain, transport: http(source.rpcUrl) });
}

export type BurnFailure =
  | 'unknown_domain'
  | 'no_receipt'
  | 'tx_reverted'
  | 'no_burn_log'
  | 'wrong_token'
  | 'wrong_recipient'
  | 'wrong_destination'
  | 'amount_mismatch';

export type VerifyBurnResult = { ok: true; depositor: Address } | { ok: false; reason: BurnFailure };

type DecodedBurn = {
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationCaller: Hex;
};

/**
 * The bridge twin of verify.ts: a burnTxHash from the browser is a HINT.
 * We re-read the receipt from the SOURCE chain and require the DepositForBurn
 * log to target our forwarder, our domain, and this invoice's exact amount
 * before any state change. The burn amount is 6-decimal USDC on the source
 * chain — the same unit as invoice.amount6, no conversion involved.
 */
export async function verifyBurn(
  invoice: Invoice,
  sourceDomain: number,
  burnTxHash: Hex,
  client?: PublicClient,
): Promise<VerifyBurnResult> {
  const source = SOURCE_CHAINS[sourceDomain];
  if (!source) return { ok: false, reason: 'unknown_domain' };

  const publicClient = client ?? sourcePublicClient(sourceDomain);

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: burnTxHash });
  } catch {
    return { ok: false, reason: 'no_receipt' };
  }
  if (!receipt) return { ok: false, reason: 'no_receipt' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };

  // Same load-bearing filter as verify.ts: only logs emitted by the real
  // TokenMessenger are believed.
  const messengerLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === TOKEN_MESSENGER.toLowerCase(),
  );

  let burn: DecodedBurn | null = null;
  for (const log of messengerLogs) {
    try {
      const ev = decodeEventLog({
        abi: TOKEN_MESSENGER_ABI,
        eventName: 'DepositForBurn',
        topics: log.topics,
        data: log.data,
      });
      burn = ev.args as DecodedBurn;
      break;
    } catch {
      // not a DepositForBurn log — keep looking
    }
  }
  if (!burn) return { ok: false, reason: 'no_burn_log' };

  // Only a USDC burn mints native value on Arc; any other token (EURC, …)
  // would strand as an ERC-20 the forwarder cannot forward.
  if (burn.burnToken.toLowerCase() !== source.usdc.toLowerCase()) {
    return { ok: false, reason: 'wrong_token' };
  }

  const forwarder32 = pad(FORWARDER_ADDRESS, { size: 32 }).toLowerCase();
  if (
    burn.mintRecipient.toLowerCase() !== forwarder32 ||
    burn.destinationCaller.toLowerCase() !== forwarder32
  ) {
    return { ok: false, reason: 'wrong_recipient' };
  }
  if (burn.destinationDomain !== ARC_DOMAIN) {
    return { ok: false, reason: 'wrong_destination' };
  }
  if (burn.amount !== invoice.amount6) {
    return { ok: false, reason: 'amount_mismatch' };
  }

  return { ok: true, depositor: burn.depositor.toLowerCase() as Address };
}

const IRIS_URL = process.env.IRIS_API_URL ?? 'https://iris-api-sandbox.circle.com';

export type Attestation =
  | { status: 'pending' }
  | { status: 'complete'; message: Hex; attestation: Hex };

/**
 * Circle's attestation service. 404 means "not indexed yet", not an error.
 * Anything 5xx throws so callers keep the row untouched and retry later.
 */
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: Hex,
  fetchFn: typeof fetch = fetch,
): Promise<Attestation> {
  const res = await fetchFn(
    `${IRIS_URL}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`,
  );
  if (res.status === 404) return { status: 'pending' };
  if (!res.ok) throw new Error(`Iris responded ${res.status}`);

  const data = await res.json();
  const msg = data.messages?.[0];
  if (!msg || msg.status !== 'complete' || !msg.attestation) return { status: 'pending' };
  return { status: 'complete', message: msg.message as Hex, attestation: msg.attestation as Hex };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/cctp.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add web/lib/cctp.ts web/test/cctp.test.ts && git commit -m "feat: add CCTP source-chain config, burn verifier, and attestation client"
```

---

## Task 4: `bridge_payments` table and `web/lib/bridge.ts`

**Files:**
- Modify: `web/db/schema.ts`
- Create: `web/lib/bridge.ts`
- Create: `web/lib/relayer.ts`
- Test: `web/test/bridge.test.ts`

**Interfaces:**
- Consumes: `verifyPayment` from `@/lib/verify` (unchanged), `fetchAttestation` from Task 3, `FORWARDER_ABI`/`FORWARDER_ADDRESS` from Task 2.
- Produces (used by Tasks 5–6):
  - `bridgePayments` table + `BridgePayment` type
  - `createBridgePayment(input: { burnTxHash: Hex; invoiceId: string; sourceDomain: number; amount6: bigint; depositor: Address }): Promise<BridgePayment>`
  - `getBridgePayment(invoiceId: string): Promise<BridgePayment | null>`
  - `listUnfinishedBridgePayments(): Promise<BridgePayment[]>`
  - `advanceBridgePayment(bp: BridgePayment, invoice: Invoice, deps?: AdvanceDeps): Promise<BridgePayment>` — one non-blocking step per call
  - `sendMintAndPay(message: Hex, attestation: Hex, invoiceId: Hex, merchant: Address): Promise<Hex>` (in `relayer.ts`)

- [ ] **Step 1: Add the table to `web/db/schema.ts`**

Append (add `integer` to the existing `drizzle-orm/pg-core` import):

```typescript
/**
 * One row per verified CCTP burn. Unlike invoice expiry, `status` is stored:
 * every step records an external fact we already observed (a receipt, an
 * attestation, a mint tx), not a value derivable at read time.
 * burn_confirmed -> attested -> paid | failed
 * (`burn_submitted` never persists: the server only inserts verified burns.)
 */
export const bridgePayments = pgTable('bridge_payments', {
  burnTxHash: text('burn_tx_hash').primaryKey(), // primary key = replay protection
  invoiceId: text('invoice_id').notNull(),
  sourceDomain: integer('source_domain').notNull(),
  amount6: numeric('amount6', { mode: 'bigint' }).notNull(),
  depositor: text('depositor').notNull(), // customer on the source chain; rescue() refund target
  status: text('status', { enum: ['burn_confirmed', 'attested', 'paid', 'failed'] })
    .notNull()
    .default('burn_confirmed'),
  message: text('message'), // hex CCTP message, set when attested
  attestation: text('attestation'), // hex, set when attested
  mintTxHash: text('mint_tx_hash'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BridgePayment = typeof bridgePayments.$inferSelect;
```

- [ ] **Step 2: Push the schema to Neon**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm drizzle-kit push
```

Expected: `bridge_payments` table created.

- [ ] **Step 3: Write the failing tests**

Create `web/test/bridge.test.ts`. The advance function takes injected deps, so no chain and no relayer key are touched; the DB is the real Neon test database (same approach as `invoices.test.ts`):

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { createInvoice, getInvoice } from '@/lib/invoices';
import {
  advanceBridgePayment,
  createBridgePayment,
  getBridgePayment,
  listUnfinishedBridgePayments,
  type AdvanceDeps,
} from '@/lib/bridge';

const MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as Address;
const MINT_TX = ('0x' + 'ee'.repeat(32)) as Hex;

function randomHash(): Hex {
  return ('0x' +
    Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      '',
    )) as Hex;
}

async function freshBridgePayment() {
  const invoice = await createInvoice({
    merchant: MERCHANT,
    amount6: 25_000_000n,
    description: 'bridge test',
  });
  const bp = await createBridgePayment({
    burnTxHash: randomHash(),
    invoiceId: invoice.id,
    sourceDomain: 6,
    amount6: invoice.amount6,
    depositor: DEPOSITOR,
  });
  return { invoice, bp };
}

function deps(overrides: Partial<AdvanceDeps> = {}): AdvanceDeps {
  return {
    fetchAttestation: vi.fn().mockResolvedValue({ status: 'pending' }),
    sendMintAndPay: vi.fn().mockResolvedValue(MINT_TX),
    confirmPayment: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('bridge payment lifecycle', () => {
  it('creates a row in burn_confirmed and finds it by invoice', async () => {
    const { invoice, bp } = await freshBridgePayment();
    expect(bp.status).toBe('burn_confirmed');
    const found = await getBridgePayment(invoice.id);
    expect(found?.burnTxHash).toBe(bp.burnTxHash);
  });

  it('stays burn_confirmed while the attestation is pending', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const after = await advanceBridgePayment(bp, invoice, deps());
    expect(after.status).toBe('burn_confirmed');
  });

  it('stores message and attestation when Iris completes', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const after = await advanceBridgePayment(bp, invoice, d);
    expect(after.status).toBe('attested');
    expect(after.message).toBe('0x1234');
    expect(after.attestation).toBe('0x5678');
    // one step per call: mintAndPay must NOT have been sent in the same call
    expect(d.sendMintAndPay).not.toHaveBeenCalled();
  });

  it('relays mintAndPay from attested and lands on paid', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const paid = await advanceBridgePayment(attested, invoice, d);

    expect(d.sendMintAndPay).toHaveBeenCalledWith('0x1234', '0x5678', invoice.id, invoice.merchant);
    expect(d.confirmPayment).toHaveBeenCalled();
    expect(paid.status).toBe('paid');
    expect(paid.mintTxHash).toBe(MINT_TX);
  });

  it('marks failed with already_settled when the router rejects the duplicate', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
      sendMintAndPay: vi.fn().mockRejectedValue(new Error('execution reverted: AlreadySettled()')),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const failed = await advanceBridgePayment(attested, invoice, d);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('already_settled');
  });

  it('leaves the row attested when the relay fails transiently, so it retries', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
      sendMintAndPay: vi.fn().mockRejectedValue(new Error('nonce too low')),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const still = await advanceBridgePayment(attested, invoice, d);
    expect(still.status).toBe('attested');
  });

  it('does not advance terminal rows', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const paid = await advanceBridgePayment(attested, invoice, d);
    const after = await advanceBridgePayment(paid, invoice, d);
    expect(after.status).toBe('paid');
    expect(d.sendMintAndPay).toHaveBeenCalledTimes(1);
  });

  it('lists only unfinished rows', async () => {
    const { bp } = await freshBridgePayment();
    const unfinished = await listUnfinishedBridgePayments();
    expect(unfinished.some((row) => row.burnTxHash === bp.burnTxHash)).toBe(true);
    expect(unfinished.every((row) => row.status === 'burn_confirmed' || row.status === 'attested')).toBe(
      true,
    );
  });
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/bridge.test.ts
```

Expected: FAIL — cannot resolve `@/lib/bridge`.

- [ ] **Step 5: Implement `web/lib/relayer.ts`**

```typescript
import { createWalletClient, http, publicActions, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '@/lib/arc';
import { FORWARDER_ABI, FORWARDER_ADDRESS } from '@/lib/forwarder';

const RPC_HTTP = process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network';

/**
 * Lazy on purpose (same reason as db/index.ts): importing this module must not
 * require RELAYER_PRIVATE_KEY, or every test touching lib/bridge.ts would.
 */
function relayerClient() {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set');
  return createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: arcTestnet,
    transport: http(RPC_HTTP),
  }).extend(publicActions);
}

/**
 * Simulate first so a deterministic revert (AlreadySettled) surfaces as an
 * exception without burning gas, then send and wait for inclusion — Arc blocks
 * are sub-second, so waiting here keeps the state machine simple.
 */
export async function sendMintAndPay(
  message: Hex,
  attestation: Hex,
  invoiceId: Hex,
  merchant: Address,
): Promise<Hex> {
  const client = relayerClient();
  const { request } = await client.simulateContract({
    address: FORWARDER_ADDRESS,
    abi: FORWARDER_ABI,
    functionName: 'mintAndPay',
    args: [message, attestation, invoiceId, merchant],
  });
  const hash = await client.writeContract(request);
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
```

- [ ] **Step 6: Implement `web/lib/bridge.ts`**

```typescript
import { and, eq, inArray } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { db } from '@/db';
import { bridgePayments, type BridgePayment, type Invoice } from '@/db/schema';
import { fetchAttestation } from '@/lib/cctp';
import { sendMintAndPay } from '@/lib/relayer';
import { verifyPayment } from '@/lib/verify';

export async function createBridgePayment(input: {
  burnTxHash: Hex;
  invoiceId: string;
  sourceDomain: number;
  amount6: bigint;
  depositor: Address;
}): Promise<BridgePayment> {
  const [row] = await db
    .insert(bridgePayments)
    .values({
      burnTxHash: input.burnTxHash.toLowerCase(),
      invoiceId: input.invoiceId,
      sourceDomain: input.sourceDomain,
      amount6: input.amount6,
      depositor: input.depositor.toLowerCase(),
    })
    .returning();
  return row;
}

export async function getBridgePayment(invoiceId: string): Promise<BridgePayment | null> {
  const [row] = await db
    .select()
    .from(bridgePayments)
    .where(eq(bridgePayments.invoiceId, invoiceId))
    .limit(1);
  return row ?? null;
}

export async function listUnfinishedBridgePayments(): Promise<BridgePayment[]> {
  return db
    .select()
    .from(bridgePayments)
    .where(inArray(bridgePayments.status, ['burn_confirmed', 'attested']));
}

async function update(
  burnTxHash: string,
  fromStatus: BridgePayment['status'],
  set: Partial<typeof bridgePayments.$inferInsert>,
): Promise<BridgePayment> {
  const [row] = await db
    .update(bridgePayments)
    .set({ ...set, updatedAt: new Date() })
    // status-guarded like markPaid: concurrent advances (poll + cron) stay idempotent
    .where(and(eq(bridgePayments.burnTxHash, burnTxHash), eq(bridgePayments.status, fromStatus)))
    .returning();
  return row;
}

export type AdvanceDeps = {
  fetchAttestation: typeof fetchAttestation;
  sendMintAndPay: typeof sendMintAndPay;
  /** Wraps verify.ts — the ONE verifier. Returns true when the invoice is now paid. */
  confirmPayment: (invoice: Invoice, mintTxHash: Hex) => Promise<boolean>;
};

const defaultDeps: AdvanceDeps = {
  fetchAttestation,
  sendMintAndPay,
  confirmPayment: async (invoice, mintTxHash) => {
    const result = await verifyPayment(invoice, mintTxHash);
    return result.ok;
  },
};

/**
 * Advance the state machine ONE non-blocking step. Called from the browser's
 * poll and from cron; never waits on the ~60s attestation, never loops.
 */
export async function advanceBridgePayment(
  bp: BridgePayment,
  invoice: Invoice,
  deps: AdvanceDeps = defaultDeps,
): Promise<BridgePayment> {
  if (bp.status === 'burn_confirmed') {
    const att = await deps.fetchAttestation(bp.sourceDomain, bp.burnTxHash as Hex);
    if (att.status !== 'complete') return bp;
    return (
      (await update(bp.burnTxHash, 'burn_confirmed', {
        status: 'attested',
        message: att.message,
        attestation: att.attestation,
      })) ?? bp
    );
  }

  if (bp.status === 'attested') {
    let mintTxHash: Hex;
    try {
      mintTxHash = await deps.sendMintAndPay(
        bp.message as Hex,
        bp.attestation as Hex,
        bp.invoiceId as Hex,
        invoice.merchant as Address,
      );
    } catch (e) {
      // Deterministic dead end: the triple is already settled on the router.
      // The relayer refunds via rescue() manually; everything else retries.
      if ((e as Error).message.includes('AlreadySettled')) {
        return (
          (await update(bp.burnTxHash, 'attested', {
            status: 'failed',
            failureReason: 'already_settled',
          })) ?? bp
        );
      }
      return bp;
    }

    await deps.confirmPayment(invoice, mintTxHash);
    return (
      (await update(bp.burnTxHash, 'attested', { status: 'paid', mintTxHash })) ?? bp
    );
  }

  return bp; // paid | failed: terminal
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/bridge.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 8: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add web/db/schema.ts web/lib/bridge.ts web/lib/relayer.ts web/test/bridge.test.ts && git commit -m "feat: add bridge_payments state machine and relayer"
```

---

## Task 5: Bridge API routes and cron fallback

**Files:**
- Create: `web/app/api/invoices/[id]/bridge/route.ts`
- Modify: `web/lib/dto.ts` (add `PublicBridge`)
- Modify: `web/app/api/cron/reconcile/route.ts`
- Test: extend `web/test/dto.test.ts`

**Interfaces:**
- Consumes: `verifyBurn` (Task 3), `createBridgePayment` / `getBridgePayment` / `advanceBridgePayment` / `listUnfinishedBridgePayments` (Task 4), `getInvoice` / `toPublicInvoice` (existing).
- Produces: `POST /api/invoices/[id]/bridge` body `{ burnTxHash, sourceDomain }` → `201 { bridge, invoice }`; `GET /api/invoices/[id]/bridge` → `200 { bridge, invoice }`; `toPublicBridge(bp): PublicBridge` where `PublicBridge = { status, burnTxHash, mintTxHash, failureReason }`.

- [ ] **Step 1: Write the failing dto test**

Append to `web/test/dto.test.ts`:

```typescript
import { toPublicBridge } from '@/lib/dto';
import type { BridgePayment } from '@/db/schema';

describe('toPublicBridge', () => {
  it('exposes only what the browser needs', () => {
    const bp: BridgePayment = {
      burnTxHash: '0x' + 'ab'.repeat(32),
      invoiceId: '0x' + 'cd'.repeat(32),
      sourceDomain: 6,
      amount6: 25_000_000n,
      depositor: '0x1111111111111111111111111111111111111111',
      status: 'attested',
      message: '0x1234',
      attestation: '0x5678',
      mintTxHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(toPublicBridge(bp)).toEqual({
      status: 'attested',
      burnTxHash: bp.burnTxHash,
      mintTxHash: null,
      failureReason: null,
    });
  });
});
```

(Adjust the import line to merge with the file's existing imports.)

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/dto.test.ts
```

Expected: FAIL — `toPublicBridge` is not exported.

- [ ] **Step 3: Add `toPublicBridge` to `web/lib/dto.ts`**

```typescript
import type { BridgePayment } from '@/db/schema';

export type PublicBridge = {
  status: 'burn_confirmed' | 'attested' | 'paid' | 'failed';
  burnTxHash: string;
  mintTxHash: string | null;
  failureReason: string | null;
};

/** The CCTP message and attestation stay server-side: the browser has no use for them. */
export function toPublicBridge(bp: BridgePayment): PublicBridge {
  return {
    status: bp.status,
    burnTxHash: bp.burnTxHash,
    mintTxHash: bp.mintTxHash,
    failureReason: bp.failureReason,
  };
}
```

(Merge the `BridgePayment` import into the existing `@/db/schema` type import.)

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm vitest run test/dto.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement the route**

Create `web/app/api/invoices/[id]/bridge/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import {
  advanceBridgePayment,
  createBridgePayment,
  getBridgePayment,
} from '@/lib/bridge';
import { SOURCE_CHAINS, verifyBurn } from '@/lib/cctp';
import { toPublicBridge, toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';

/**
 * The browser reports a burn it claims to have made on the source chain.
 * Nothing is believed: verifyBurn re-reads the receipt from that chain and
 * requires forwarder recipient + Arc domain + exact invoice amount.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { burnTxHash, sourceDomain } = await req.json();

  if (typeof burnTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
    return NextResponse.json({ error: 'invalid burnTxHash' }, { status: 400 });
  }
  if (typeof sourceDomain !== 'number' || !SOURCE_CHAINS[sourceDomain]) {
    return NextResponse.json({ error: 'unsupported source domain' }, { status: 400 });
  }

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Idempotent: re-posting the same burn returns the existing row.
  const existing = await getBridgePayment(id);
  if (existing) {
    return NextResponse.json({
      bridge: toPublicBridge(existing),
      invoice: toPublicInvoice(invoice),
    });
  }

  const result = await verifyBurn(invoice, sourceDomain, burnTxHash as Hex);
  if (!result.ok) {
    return NextResponse.json({ error: 'burn verification failed', reason: result.reason }, {
      status: 400,
    });
  }

  const bridge = await createBridgePayment({
    burnTxHash: burnTxHash as Hex,
    invoiceId: id,
    sourceDomain,
    amount6: invoice.amount6,
    depositor: result.depositor,
  });

  return NextResponse.json(
    { bridge: toPublicBridge(bridge), invoice: toPublicInvoice(invoice) },
    { status: 201 },
  );
}

/** Poll target: each call advances the state machine one non-blocking step. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let bridge = await getBridgePayment(id);
  if (!bridge) return NextResponse.json({ error: 'no bridge payment' }, { status: 404 });

  if (bridge.status === 'burn_confirmed' || bridge.status === 'attested') {
    bridge = await advanceBridgePayment(bridge, invoice);
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({
    bridge: toPublicBridge(bridge),
    invoice: toPublicInvoice(fresh!),
  });
}
```

- [ ] **Step 6: Extend the cron reconciler**

In `web/app/api/cron/reconcile/route.ts`, add to the imports:

```typescript
import { advanceBridgePayment, listUnfinishedBridgePayments } from '@/lib/bridge';
```

and insert before the final `return NextResponse.json(...)` (adjusting that
return to include `bridged`):

```typescript
  // Second safety net: bridge payments whose browser died mid-flight. Two
  // advance calls per row so an attestation that completed since the last run
  // still reaches mintAndPay in a single cron pass.
  let bridged = 0;
  for (const bp of await listUnfinishedBridgePayments()) {
    const invoice = await getInvoice(bp.invoiceId);
    if (!invoice) continue;
    let current = bp;
    for (let i = 0; i < 2 && (current.status === 'burn_confirmed' || current.status === 'attested'); i++) {
      current = await advanceBridgePayment(current, invoice);
    }
    if (current.status === 'paid') bridged++;
  }

  return NextResponse.json({ checked: pending.length, settled, bridged });
```

(Delete the old `return NextResponse.json({ checked: pending.length, settled });` line.)

- [ ] **Step 7: Typecheck and run the full web suite**

```bash
cd /Users/vanhuy/Desktop/arc/web && rm -f tsconfig.tsbuildinfo && npx tsc --noEmit && pnpm vitest run
```

Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add web/app/api/invoices/\[id\]/bridge/route.ts web/lib/dto.ts web/app/api/cron/reconcile/route.ts web/test/dto.test.ts && git commit -m "feat: add bridge API routes and cron fallback for stuck bridge payments"
```

---

## Task 6: Checkout UI — pay from Base Sepolia

**Files:**
- Modify: `web/lib/wagmi.ts`
- Create: `web/app/pay/[id]/bridge-checkout.tsx`
- Modify: `web/app/pay/[id]/checkout.tsx`

**Interfaces:**
- Consumes: `SOURCE_CHAINS`, `TOKEN_MESSENGER`, `TOKEN_MESSENGER_ABI`, `ERC20_ABI`, `ARC_DOMAIN`, `STANDARD_FINALITY`, `baseSepolia` from Task 3; `FORWARDER_ADDRESS` from Task 2; `POST`/`GET /api/invoices/[id]/bridge` from Task 5; `PublicInvoice`, `PublicBridge` from dto.
- Produces: `<BridgeCheckout invoice={PublicInvoice} />` client component; a source toggle inside `Checkout`.

Read `web/AGENTS.md` and skim `node_modules/next/dist/docs/` for client-component conventions before editing — this is Next 16.

- [ ] **Step 1: Add Base Sepolia to wagmi**

Replace `web/lib/wagmi.ts` with:

```typescript
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { arcTestnet } from '@/lib/arc';
import { baseSepolia, SOURCE_CHAINS } from '@/lib/cctp';

export const wagmiConfig = createConfig({
  chains: [arcTestnet, baseSepolia],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network'),
    [baseSepolia.id]: http(SOURCE_CHAINS[6].rpcUrl),
  },
  ssr: true,
});
```

- [ ] **Step 2: Implement `web/app/pay/[id]/bridge-checkout.tsx`**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { pad, type Hex } from 'viem';
import {
  ARC_DOMAIN,
  baseSepolia,
  ERC20_ABI,
  SOURCE_CHAINS,
  STANDARD_FINALITY,
  TOKEN_MESSENGER,
  TOKEN_MESSENGER_ABI,
} from '@/lib/cctp';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { wagmiConfig } from '@/lib/wagmi';
import type { PublicBridge, PublicInvoice } from '@/lib/dto';

type Phase = 'idle' | 'approving' | 'burning' | 'bridging' | 'failed' | 'error';

const POLL_MS = 3000;
const BASE = SOURCE_CHAINS[6];

const STEP_LABELS = [
  'Approve USDC on Base',
  'Burn on Base Sepolia',
  'Circle attestation (~1 min)',
  'Minted & paid on Arc',
];

/** Index of the step currently in progress; everything before it is done. */
function activeStep(phase: Phase): number {
  return phase === 'approving' ? 0 : phase === 'burning' ? 1 : 2;
}

export function BridgeCheckout({ invoice }: { invoice: PublicInvoice }) {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>('idle');
  const [bridge, setBridge] = useState<PublicBridge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the server while it relays attestation -> mint -> pay.
  useEffect(() => {
    if (phase !== 'bridging') return;
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/invoices/${invoice.id}/bridge`);
      if (!res.ok) return; // transient — next tick retries
      const data = await res.json();
      setBridge(data.bridge);
      // Paid: reload so the page shows the standard receipt view (the mint tx
      // is now the invoice's txHash — same InvoicePaid path as a direct payment).
      if (data.bridge.status === 'paid') location.reload();
      if (data.bridge.status === 'failed') setPhase('failed');
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, invoice.id]);

  async function payFromBase() {
    setError(null);
    try {
      if (chainId !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }

      const amount6 = BigInt(invoice.amount6); // 6-decimal, same unit the burn uses

      setPhase('approving');
      const approveHash = await writeContractAsync({
        chainId: baseSepolia.id,
        address: BASE.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TOKEN_MESSENGER, amount6],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: baseSepolia.id });

      setPhase('burning');
      const forwarder32 = pad(FORWARDER_ADDRESS, { size: 32 });
      const burnHash = await writeContractAsync({
        chainId: baseSepolia.id,
        address: TOKEN_MESSENGER,
        abi: TOKEN_MESSENGER_ABI,
        functionName: 'depositForBurn',
        args: [amount6, ARC_DOMAIN, forwarder32, BASE.usdc, forwarder32, 0n, STANDARD_FINALITY],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: burnHash, chainId: baseSepolia.id });

      // Report the burn — the server re-verifies it before trusting anything.
      const res = await fetch(`/api/invoices/${invoice.id}/bridge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ burnTxHash: burnHash, sourceDomain: BASE.domain }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.reason ?? body.error ?? 'burn rejected');
      }
      setBridge((await res.json()).bridge);
      setPhase('bridging');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'idle' || phase === 'error') {
    return (
      <>
        <button className="act" disabled={invoice.status === 'expired'} onClick={payFromBase}>
          Pay {invoice.amountDisplay} USDC from Base Sepolia
        </button>
        <p className="note">
          Two signatures on Base — the rest settles on Arc automatically.
        </p>
        {error && <p className="banner banner--danger">{error}</p>}
      </>
    );
  }

  const current = activeStep(phase);

  return (
    <div aria-live="polite">
      <ol className="bridge-steps">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className={i < current ? 'done' : i === current ? 'active' : ''}>
            {label}
          </li>
        ))}
      </ol>

      {phase === 'bridging' && (
        <p className="note">
          Bridging via CCTP. You can close this page — the payment completes on its own.
        </p>
      )}

      {phase === 'failed' && (
        <p className="banner banner--danger">
          Bridge payment failed ({bridge?.failureReason ?? 'unknown'}). Your USDC will be
          refunded to your address on Arc — contact the merchant.
        </p>
      )}
    </div>
  );
}
```

Add minimal styles for `.bridge-steps` / `.done` to `web/app/globals.css`, matching the existing design language (checkmark or muted/active states — reuse the existing CSS variables like `var(--label)`).

- [ ] **Step 3: Add the source toggle to `checkout.tsx`**

In `web/app/pay/[id]/checkout.tsx`:

1. Import the new component and `useState` source:

```tsx
import { BridgeCheckout } from './bridge-checkout';
```

```tsx
const [source, setSource] = useState<'arc' | 'base'>('arc');
```

2. In the unpaid branch (after the `receipt-meta` block, before the connect/pay controls), render the toggle, and gate the existing pay controls on `source === 'arc'`:

```tsx
<div className="source-toggle" role="tablist" aria-label="Pay from">
  <button
    role="tab"
    aria-selected={source === 'arc'}
    className={source === 'arc' ? 'on' : ''}
    onClick={() => setSource('arc')}
  >
    Arc
  </button>
  <button
    role="tab"
    aria-selected={source === 'base'}
    className={source === 'base' ? 'on' : ''}
    onClick={() => setSource('base')}
  >
    Base Sepolia
  </button>
</div>
```

```tsx
{source === 'base' ? (
  !isConnected ? (
    <button className="act" onClick={() => connect({ connector: connectors[0] })}>
      Connect wallet
    </button>
  ) : (
    <BridgeCheckout invoice={invoice} />
  )
) : /* existing !isConnected / working / pay-button chain, unchanged */}
```

3. Guard the existing auto-switch effect so it does not yank the wallet back to Arc mid-bridge:

```tsx
useEffect(() => {
  if (source === 'arc' && wrongChain) switchChain({ chainId: arcTestnet.id });
}, [source, wrongChain, switchChain]);
```

4. The paid state needs no wiring here: `BridgeCheckout` calls `location.reload()` when the poll reports `paid`, and the page re-renders as the existing receipt view (the mint tx is the invoice's `txHash`).

Add `.source-toggle` styles to `globals.css` in the existing visual language.

- [ ] **Step 4: Typecheck and build**

```bash
cd /Users/vanhuy/Desktop/arc/web && rm -f tsconfig.tsbuildinfo && npx tsc --noEmit && pnpm next build
```

Expected: clean build. (`next build` is what catches type errors CI-style.)

- [ ] **Step 5: Verify in the browser**

```bash
cd /Users/vanhuy/Desktop/arc/web && pnpm dev
```

Open an invoice's `/pay/[id]`: the toggle renders, "Arc" shows the unchanged flow, "Base Sepolia" shows the new button. A full crosschain payment is exercised in Task 7 (it needs the funded Base wallet).

- [ ] **Step 6: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add web/lib/wagmi.ts web/app/pay/\[id\]/bridge-checkout.tsx web/app/pay/\[id\]/checkout.tsx web/app/globals.css && git commit -m "feat: add pay-from-Base-Sepolia flow to checkout"
```

---

## Task 7: End-to-end verification and docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above, deployed and wired.

- [ ] **Step 1: Fund the customer test wallet**

- USDC on Base Sepolia: https://faucet.circle.com (select Base Sepolia).
- Base Sepolia ETH for gas: https://www.alchemy.com/faucets/base-sepolia (or any Base Sepolia faucet).

- [ ] **Step 2: Run the full crosschain payment**

1. `cd /Users/vanhuy/Desktop/arc/web && pnpm dev`
2. Dashboard → create an invoice for a small amount (e.g. 1 USDC).
3. Open the POS screen for the invoice in one tab, `/pay/[id]` in another.
4. Pay via "Base Sepolia" with the funded wallet: two signatures, then watch the stepper.
5. Expected within ~2 minutes: stepper reaches "Minted & paid on Arc", the POS tab beeps and flips to paid, the dashboard shows the invoice paid, and `bridge_payments.status = 'paid'` with a `mint_tx_hash` visible on https://testnet.arcscan.app whose logs contain the router's `InvoicePaid`.
6. Record the observed end-to-end time (burn submission → POS beep) for the README.

- [ ] **Step 3: Verify the safety net**

1. Create a second invoice; pay from Base but **close the pay tab immediately after the burn confirms** (before the attestation lands).
2. Trigger the cron manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reconcile
```

(run twice ~90 s apart if the first pass reports the attestation still pending).
3. Expected: response includes `"bridged": 1`, the invoice flips to paid with no browser involved.

- [ ] **Step 4: Run every suite**

```bash
cd /Users/vanhuy/Desktop/arc/contracts && forge test && cd ../web && pnpm vitest run && rm -f tsconfig.tsbuildinfo && npx tsc --noEmit && pnpm next build
```

Expected: 13 forge tests pass, all vitest suites pass, clean typecheck and build.

- [ ] **Step 5: Update `CLAUDE.md`**

Add to the invariants section:

```markdown
6. **CCTP burns are verified server-side.** A `burnTxHash` from a browser is a hint;
   `web/lib/cctp.ts#verifyBurn` re-reads the source-chain receipt and requires
   forwarder recipient + destinationCaller, Arc domain, and exact invoice amount.
   `web/lib/verify.ts` remains the only verifier for Arc-side settlement.
7. **The forwarder never converts decimals.** `CrossPayForwarder` forwards its native
   balance delta; the CCTP burn amount is 6-decimal USDC == `invoice.amount6` (same
   unit, not a conversion). `usdc.ts` stays the only converting module.
```

Add to the gotchas section:

```markdown
- **CCTP v2 event ≠ v1.** `DepositForBurn` v2 has no nonce and ends with `hookData`;
  the Iris v2 API is `GET /v2/messages/{domain}?transactionHash=…` and returns 404
  (not pending) until the burn is indexed. Addresses are identical on every chain.
- **The relayer key (`RELAYER_PRIVATE_KEY`) is ops infrastructure**, not the merchant
  and not the deployer. It needs a little USDC on Arc for `mintAndPay` gas. If bridge
  payments stall at `attested`, check its balance first.
```

Update the Layout section to mention `cctp.ts`, `bridge.ts`, `relayer.ts`, `forwarder.ts`, and `contracts/src/CrossPayForwarder.sol` (deployed address once known).

- [ ] **Step 6: Update `README.md`**

Add a "Pay from another chain (CCTP v2)" section: one paragraph on the flow (burn on Base Sepolia → Circle attestation → `CrossPayForwarder.mintAndPay` on Arc → same `InvoicePaid` event), the measured end-to-end time from Step 2, and the two new env keys.

- [ ] **Step 7: Commit**

```bash
cd /Users/vanhuy/Desktop/arc && git add CLAUDE.md README.md && git commit -m "docs: document crosschain CCTP checkout and its invariants"
```
