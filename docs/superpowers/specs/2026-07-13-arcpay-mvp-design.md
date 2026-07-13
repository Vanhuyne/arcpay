# ArcPay — MVP Design Spec

- **Date:** 2026-07-13
- **Status:** Approved, ready for implementation planning
- **Goal:** Circle / Arc Chain hackathon & grant submission

---

## 1. Summary

ArcPay is a point-of-sale payment gateway built on **Arc Chain** — Circle's Layer-1 that uses USDC as its native gas token.

A merchant creates an invoice and displays a QR code. The customer scans it with their phone camera, lands on a checkout page, taps pay once, and the merchant's screen flips to **PAID** in under a second.

**Why this has to be Arc, and not Base or Polygon:** on every other EVM chain, paying with USDC still requires the customer to hold ETH or MATIC for gas. A coffee shop and its customers will never do that. On Arc, gas *is* USDC — the customer needs exactly **one asset** in their wallet. Combined with sub-second deterministic finality and no reorgs, "paid" genuinely means paid, right at the counter.

---

## 2. Arc technical context

Every design decision in this document rests on the facts below.

| Parameter | Value |
|---|---|
| Chain ID | `5042002` |
| RPC (HTTP) | `https://rpc.testnet.arc.network` |
| RPC (WebSocket) | `wss://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Block time | ~0.48s |
| Finality | < 1s, deterministic (Malachite BFT), no reorgs |
| Execution | Reth — full EVM, Osaka baseline |
| Gas token | USDC (native) |
| Target tx cost | ~$0.01 |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` |

**Three differentiators this design exploits directly:**

1. **USDC is native gas.** The customer needs no second token. This is the entire product thesis.
2. **EIP-7708 — every native USDC movement emits a `Transfer` log.** On Ethereum, native transfers emit nothing, so detecting a payment means scanning every transaction in a block. On Arc, detecting a payment is just listening to logs.
3. **Sub-second finality.** A transaction can be treated as final at the counter — no "wait for N confirmations".

**Critical warning — dual decimals:** native USDC uses **18 decimals** (`msg.value`, gas), while the ERC-20 interface uses **6 decimals** (`balanceOf`, `transfer`). These are the **same balance**, viewed two ways. Mixing them up is a one-million-fold error. See section 5.

---

## 3. Users and capabilities

Exactly **two** personas. Every extra persona is another screen, more state, and one more thing to break during the demo.

### 3.1. Merchant

The wallet *is* the account. Login is **SIWE** (Sign-In With Ethereum) — no email, no password, no KYC. The address they sign in with is also the address that receives funds, so there is no "configure payout account" step.

| Capability | Description |
|---|---|
| Create invoice | Enter an amount (USDC) and a short description. The system mints an `invoiceId` and a payment link. **No gas, no signature required.** |
| POS screen | Full-screen page: large QR, large amount. Live-updating: waiting → **PAID** with a sound. This is the heart of the demo. |
| Dashboard | Invoice list (pending / paid / expired), total revenue, wallet USDC balance, ArcScan link per transaction. |
| Payment detail | Who paid, when, tx hash, **the transaction's gas fee (paid by the customer, denominated in USDC)**, and **time from tap-to-pay to finality**. |

### 3.2. Customer

**No account, and never needs one.** They pass through once. Any friction here is fatal friction.

1. Scan the QR with the phone camera (no dedicated app) → checkout page opens, showing who they're paying, how much, and for what.
2. Connect wallet. If the wallet lacks the Arc network → one-tap add via `wallet_addEthereumChain`. If they hold no testnet USDC → a button straight to Circle's faucet.
3. Tap "Pay 5.00 USDC" → sign **exactly one** transaction → success screen with an explorer link.

**No token approval. No ETH needed for gas. No token swap.** This must be visible on the UI, not buried in a slide.

### 3.3. Deliberately NOT in the MVP

No staff accounts or roles, no multi-store, no refunds, no recurring payments, no fiat on-ramp, no platform admin.

Two extensions are pre-approved **if time allows** (the design leaves room, but they will not be built): on-chain refunds, and auto-sweeping idle revenue into **USYC** to earn yield. Note that USYC has a `USYC Entitlements` contract — it almost certainly requires whitelisting, which must be verified before committing to it.

---

## 4. Smart contract — `PaymentRouter`

### 4.1. Decision: a stateless router

Invoices are **not** registered on-chain up front. The textbook approach (merchant calls `createInvoice()`, then the customer calls `pay()`) forces a cashier to open their wallet and sign a transaction for every cup of coffee. Nobody will do that, and it forces the merchant to always hold USDC just to create invoices.

Instead: invoices live in the database, and the customer carries `(invoiceId, merchant, amount)` in calldata when paying.

**Consequence:** the merchant **never signs anything and never spends a cent on gas.** Creating an invoice is a single `INSERT`. The customer bears all on-chain cost — exactly as in the physical world.

### 4.2. The stateless vulnerability, and the fix

If the contract deduplicated on `paid[invoiceId]`, a griefer could call `pay(your_invoiceId, their_wallet, 0.01 USDC)`:

- Your 500 USDC invoice is marked "paid" on-chain for one cent.
- When the real customer pays, their transaction **reverts** with "already paid".
- The attacker neutralizes any invoice for near-zero cost.

**The fix:** the dedup key is not `invoiceId`, but `keccak256(invoiceId, merchant, amount)`.

A griefer paying the wrong amount now produces a completely different `key` — the real invoice still settles normally, and they have only burned their own money. The backend, in turn, **only trusts events that match all three fields against the database** (section 6.3), so the junk event is discarded.

### 4.3. Source

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Routes native USDC payments on Arc and emits events for reconciliation.
/// @dev The contract never holds funds: whatever comes in is forwarded to the merchant
///      in the same transaction. No owner, no upgrade path, no withdrawal function.
contract PaymentRouter {
    /// @dev amount is denominated in 18 decimals (native USDC / msg.value).
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64  timestamp
    );

    /// @dev key = keccak256(invoiceId, merchant, amount).
    ///      Keyed on all three fields so that a payment with the wrong amount
    ///      cannot block the correct payment for the same invoiceId.
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
        settled[key] = true;

        (bool ok, ) = merchant.call{value: amount}("");
        if (!ok) revert ForwardFailed();

        emit InvoicePaid(invoiceId, merchant, msg.sender, amount, uint64(block.timestamp));
    }
}
```

### 4.4. Safety properties

- **Reentrancy-safe:** `settled[key] = true` is written **before** the transfer (checks-effects-interactions). A malicious merchant contract cannot re-enter.
- **Cannot custody anyone's funds:** no owner, no upgrade, no withdrawal function. All of `msg.value` is forwarded within the same transaction.
- **Zero address:** Arc reverts on native transfers to `0x0`; we reject early with `InvalidMerchant` so the failure is legible.

### 4.5. Settled trade-off: forward, not escrow

The contract forwards funds straight to the merchant rather than escrowing them.

- **Gain:** "your money lands in your wallet in 0.5 seconds, with no intermediary" — a strong thesis, and the contract cannot be drained.
- **Cost:** no on-chain refunds (a refund means the merchant sends funds back manually).

The MVP already excludes refunds, so this trade-off is pure upside.

---

## 5. Decimals convention (MANDATORY)

This is the most dangerous source of bugs in the project. It is handled with **discipline**, not with care.

| Layer | Unit | Example (5 USDC) |
|---|---|---|
| Database, all APIs, all UI | integer, **6 decimals** (Stripe-style "cents") | `5000000` |
| Anything touching the chain | `bigint`, **18 decimals** | `5000000000000000000n` |
| Contract | only knows `msg.value` (18 decimals) | — |

**Conversion may occur in exactly one file: `web/lib/usdc.ts`.**

```ts
export const USDC_SCALE = 10n ** 12n; // 18 - 6

export function toNative(amount6: bigint): bigint { return amount6 * USDC_SCALE; }
export function fromNative(wei: bigint): bigint  { return wei / USDC_SCALE; }
export function formatUsdc(amount6: bigint): string { /* "5.00" */ }
```

**No other component, route, or hook may multiply or divide by `1e12`.** Violating this convention is a merge-blocking review finding.

---

## 6. Architecture and data flow

### 6.1. Principle: no long-running indexer

The conventional architecture needs a Node process holding a WebSocket, listening for logs and writing to the database. It is correct — but it is **one more server to deploy and keep alive, and it will die exactly during the demo**.

Arc offers a cleaner escape thanks to instant finality: **the server can verify a payment on its own with a single RPC call.** The whole system runs on Vercel with no process to keep alive, while **trusting the client with nothing**.

### 6.2. Payment flow

```
Merchant                    Server                     Chain                  Customer
   │                          │                          │                       │
   ├─ POST /api/invoices ────>│                          │                       │
   │  (SIWE session)          ├─ INSERT invoice          │                       │
   │<──── payUrl + QR ────────┤   (pending)              │                       │
   │                          │                          │                       │
   │  [POS screen]            │                          │                       │
   │  ├─ poll GET /:id (400ms)│                          │                       │
   │  └─ watch InvoicePaid ───┼─────────────────────────>│  (WSS, filter by id)  │
   │                          │                          │                       │
   │                          │          scan QR ────────┼──────────────────────>│
   │                          │<──── GET /api/invoices/:id (public) ─────────────┤
   │                          │                          │<─── pay(), 1 tx ──────┤
   │                          │                          │                       │
   │                          │                          ├─ InvoicePaid event    │
   │                          │                          ├─ funds → merchant     │
   │                          │                          │                       │
   │                          │<──── POST /:id/confirm { txHash } ───────────────┤
   │                          │                          │      (a HINT, not trusted)
   │                          ├─ eth_getTransactionReceipt(txHash) ──>│          │
   │                          ├─ VERIFY (section 6.3)    │                       │
   │                          ├─ UPDATE status = paid    │                       │
   │                          │                          │                       │
   │<──────── "PAID" ─────────┤                          │                       │
```

**Three independent detection paths, all funnelling into one verifier:**

1. **The customer's tab** reports `txHash` once it has a receipt (fastest; always present in the happy path).
2. **The merchant's POS screen** independently watches `InvoicePaid` over WebSocket, filtered by `invoiceId`. This path survives the customer closing their tab. When the POS sees the event, it also posts the `txHash` to `/confirm`.
3. **A Vercel Cron, once a minute,** sweeps `pending` invoices, calls `eth_getLogs` filtered by the `invoiceId` topic, and runs the same verification. This is the final safety net for when both tabs are gone.

Whichever path fires first wins. The verifier is **idempotent**, so overlapping paths are harmless.

### 6.3. The verifier — the single source of truth

`POST /api/invoices/:id/confirm { txHash }` — the server treats `txHash` as a **hint**, never as proof, and goes to the chain itself:

1. `eth_getTransactionReceipt(txHash)` → must exist and have `status === 'success'`.
2. The receipt must contain a log emitted by the **exact `PaymentRouter` address**.
3. Decode the `InvoicePaid` log and check **all three** fields against the database row:
   - `invoiceId` matches this invoice,
   - `merchant` equals the merchant's wallet in the database,
   - `amount` equals `toNative(amount6)` from the database — **exact equality, no tolerance**.
4. Only if all three match → `UPDATE status = 'paid'`, storing `txHash`, `payer`, `blockNumber`, `paidAt`, `gasFee`.
5. If the invoice is already `paid` → return success without rewriting (idempotent).

The client may lie freely; it changes nothing. Truth lives on the chain, and the server always asks the chain.

### 6.4. Invoice lifecycle

Three states, no more:

```
pending ──(verification succeeds)──> paid
   │
   └──(past expiresAt, 15 min)──────> expired
```

`expired` is **derived from the `expiresAt` column at read time** — no cleanup job needed.

**A handled edge case:** if a customer pays an already-`expired` invoice, the funds still reach the merchant's wallet (the contract knows nothing about expiry). On verification, the server **still marks the invoice `paid`**, with a `wasLate = true` flag. Recording a late payment beats taking someone's money while the system says "unpaid" — and this is precisely the class of edge case that breaks hackathon demos.

---

## 7. Data model

```ts
// db/schema.ts — Drizzle + Postgres (Neon)

merchants {
  address     text primary key      // lowercase; checksummed only for display
  name        text
  createdAt   timestamptz
}

invoices {
  id          text primary key      // invoiceId: random 32-byte hex
  merchant    text references merchants(address)
  amount6     bigint                // 6 decimals — see section 5
  description text
  status      text                  // 'pending' | 'paid'  (expired is derived from expiresAt)
  createdAt   timestamptz
  expiresAt   timestamptz           // createdAt + 15 min

  // populated on successful verification
  txHash      text
  payer       text
  blockNumber bigint
  paidAt      timestamptz
  gasFee      bigint                // 18 decimals — powers the "fee paid in USDC" story
  wasLate     boolean default false
}
```

`invoiceId` is a random 32-byte value (unguessable), used directly as the `bytes32` in calldata.

---

## 8. API

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/auth/siwe` | — | SIWE verification, creates the merchant session |
| `POST /api/invoices` | SIWE | Create invoice `{ amount6, description }` → `{ id, payUrl }` |
| `GET /api/invoices/:id` | public | Read an invoice (merchant, amount, description, status). Used by both the checkout page and the POS screen. |
| `POST /api/invoices/:id/confirm` | public | Accepts `{ txHash }` (a hint) → runs the verifier from section 6.3 |
| `GET /api/invoices` | SIWE | The merchant's invoice list plus total revenue |
| `GET /api/cron/reconcile` | Cron secret | Reconciles pending invoices via `eth_getLogs` |

`GET /api/invoices/:id` is public by design — the customer has no account, and an invoice is only reachable by knowing its random 32-byte `invoiceId`.

---

## 9. Repository layout and stack

```
arcpay/
├─ contracts/                       Foundry
│  ├─ src/PaymentRouter.sol
│  ├─ test/PaymentRouter.t.sol
│  └─ script/Deploy.s.sol
└─ web/                             Next.js (App Router) — deployed on Vercel
   ├─ app/
   │  ├─ dashboard/                 merchant: invoices + revenue
   │  ├─ pos/[id]/                  merchant: full-screen QR
   │  ├─ pay/[id]/                  customer: checkout ← heart of the demo
   │  └─ api/
   │     ├─ auth/siwe/
   │     ├─ invoices/
   │     ├─ invoices/[id]/confirm/
   │     └─ cron/reconcile/
   ├─ lib/
   │  ├─ arc.ts                     chain config, viem clients (HTTP + WSS)
   │  ├─ usdc.ts                    ← THE ONLY place decimals are converted
   │  ├─ router.ts                  PaymentRouter ABI + address
   │  └─ verify.ts                  the section 6.3 verifier (shared by confirm + cron)
   └─ db/schema.ts                  Drizzle + Postgres (Neon)
```

| Component | Choice | Rationale |
|---|---|---|
| Contract | **Foundry** | Tests written in Solidity, fast; recommended by Arc docs |
| Web | **Next.js App Router** on Vercel | No long-running server required |
| Chain | **viem + wagmi** | Docs state `viem` ships Arc Testnet as a built-in chain — **must be verified in the first implementation step** |
| DB | **Neon Postgres** (Vercel Marketplace) | Serverless, nothing to babysit |
| Auth | **SIWE** | The wallet is the account; no passwords |

`lib/verify.ts` is shared by `/confirm` and `/cron/reconcile` — there is exactly **one** implementation of the verification logic, never duplicated.

---

## 10. Test plan

### 10.1. Contract (Foundry)

| Test | Expectation |
|---|---|
| Correct payment | Funds reach the merchant; `InvoicePaid` carries all five fields correctly |
| `msg.value` ≠ `amount` | Reverts with `AmountMismatch` |
| Replay of the same triple | Reverts with `AlreadySettled` |
| **A griefer paying the wrong amount does NOT block the real invoice** | The real payment still succeeds — **the most important test in the suite** |
| Malicious merchant contract attempts reentrancy | Cannot extract a second payment |
| `merchant == address(0)` | Reverts with `InvalidMerchant` |

### 10.2. Backend

| Test | Expectation |
|---|---|
| `confirm` with a fabricated txHash | Rejected |
| txHash belonging to a **different** invoice | Rejected |
| Valid txHash but mismatched amount | Rejected |
| Log emitted by a contract other than `PaymentRouter` | Rejected |
| `confirm` called twice | Recorded once (idempotent) |
| Payment arriving after expiry | `paid` with `wasLate = true` |

### 10.3. End-to-end (against real Arc testnet)

Deploy the real contract to Arc testnet, run a script that makes a real payment, and assert the invoice flips to `paid`.

**Measure and record:** time from tapping "Pay" to finality, and the actual gas fee (in USDC). Both numbers go on the slide.

---

## 11. MVP success criteria

1. On real Arc testnet: create invoice → scan QR with a phone → pay → the POS screen flips, **measurably in under one second**.
2. The customer completes payment **holding only USDC** — no second token, no approval, a single signature.
3. The server **trusts no client**: every forgery in section 10.2 is rejected.
4. The merchant **pays no gas** and signs nothing across the entire invoice lifecycle.
5. The UI surfaces **the gas fee denominated in USDC** and **time-to-finality** — live evidence for the "why Arc" thesis.

---

## 12. Known risks

| Risk | Level | Mitigation |
|---|---|---|
| `viem` may not actually ship Arc Testnet built in | Medium | Verify in the first step; if absent, define the chain by hand (~10 lines) |
| Confusing 18- vs 6-decimal values | **High** | Section 5 convention, isolated in `lib/usdc.ts`, covered by tests |
| Mobile wallets lacking Arc network support | Medium | The QR encodes a **checkout URL**, not EIP-681 — the page calls `wallet_addEthereumChain` itself |
| Testnet RPC flakiness during the demo | Medium | Configure fallback RPCs (Blockdaemon / dRPC / QuickNode) |
| USYC gated behind Entitlements | Low (already out of scope) | Extension only; verify before committing |

---

## 13. Out of scope (priority order if time allows)

1. **On-chain refunds** — requires switching the contract to an escrow model.
2. **Idle revenue auto-earning yield via USYC** — verify the Entitlements whitelist first.
3. **Crosschain funding via CCTP / Gateway** — let customers pay from Base or Ethereum.
4. **Gasless payments via EIP-7702** — Arc supports set-code transactions.
