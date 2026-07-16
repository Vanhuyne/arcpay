# Crosschain checkout via CCTP v2 (Base Sepolia → Arc) — Design

Date: 2026-07-16
Status: approved for planning
Builds on: `2026-07-13-arcpay-mvp-design.md` (extension #3 in its out-of-scope list)

## 1. Goal

A customer holding USDC on Base Sepolia (and nothing on Arc) can pay an ArcPay
invoice from the existing checkout page, signing only on Base. The merchant
experience does not change at all: the POS screen still hears `InvoicePaid`
from the deployed `PaymentRouter` and the merchant still never signs a
transaction or pays gas.

Success criteria:

- A real invoice on Arc Testnet is paid end-to-end from a wallet whose only
  funds are USDC + ETH on Base Sepolia.
- The customer signs exactly two transactions, both on Base Sepolia.
- `web/lib/verify.ts` is not modified. The POS screen is not modified.
- All existing tests keep passing; new Foundry and Vitest suites cover the new
  contract and the new web helpers.

## 2. Mechanism (CCTP v2 burn-and-mint)

CCTP v2 is deployed on both chains at the same addresses:

| Contract | Address | Notes |
| --- | --- | --- |
| TokenMessengerV2 (both chains) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | initiates burns |
| MessageTransmitterV2 (both chains) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | mints on receive |
| Arc CCTP domain | `26` | destination |
| Base Sepolia CCTP domain | `6` | source |

Flow: `approve` + `depositForBurn` on Base Sepolia → Circle Iris (sandbox)
attests (~60 s for Base) → `receiveMessage` on Arc mints **native** USDC to the
mint recipient. USDC minted on Arc is the native asset — it is money and gas at
once, never wrapped.

The burn call is CCTP v2's `depositForBurn` with:

- `amount` = invoice amount (6-decimal),
- `destinationDomain` = 26,
- `mintRecipient` = the `CrossPayForwarder` address (bytes32-padded),
- `destinationCaller` = the `CrossPayForwarder` address, so **only the
  forwarder can execute this message** on Arc — nobody can mint it anywhere
  else,
- standard-transfer finality (`minFinalityThreshold` = 2000, `maxFee` = 0) so
  the minted amount equals the burned amount exactly.

> Verify the exact v2 signature and the Iris sandbox endpoint
> (`iris-api-sandbox.circle.com`) against Circle's docs during implementation;
> the Arc docs page shows a simplified 4-arg form.

## 3. New contract: `contracts/src/CrossPayForwarder.sol`

The bridge between a CCTP mint and an invoice payment. Immutable references to
`MessageTransmitterV2` and `PaymentRouter`; a `relayer` address set at deploy.

```solidity
function mintAndPay(bytes message, bytes attestation,
                    bytes32 invoiceId, address merchant) external onlyRelayer
```

1. Record native balance, call `messageTransmitter.receiveMessage(message,
   attestation)` — CCTP mints native USDC to this contract.
2. Compute `delta` = native balance increase. Revert if zero.
3. Call `router.pay{value: delta}(invoiceId, merchant, delta)` — the deployed
   router's signature is `pay(bytes32 invoiceId, address merchant, uint256
   amount)` with a settle key over all three fields; it emits `InvoicePaid`
   exactly as in the direct-pay flow.

Design points:

- **Atomic**: if `pay` reverts the whole tx reverts and the CCTP message stays
  unconsumed; the relayer can retry safely. `MessageTransmitterV2` itself
  prevents replay after success.
- **No on-chain decimal conversion**: the mint credits the native (18-decimal)
  balance directly, so forwarding the balance delta needs no 6→12→18
  arithmetic. Invariant 1 (only `usdc.ts` converts) survives untouched.
- **Griefing-resistant**: `destinationCaller` pins execution to the forwarder,
  and `onlyRelayer` on `mintAndPay` stops a third party from supplying a fake
  `merchant` and stealing the mint.
- **`rescue(bytes message, bytes attestation, address to)` (onlyRelayer)**:
  escape hatch for a burn that must never be paid (e.g. wrong amount) — mints
  and forwards to `to` instead of the router.
- Foundry tests use a mock MessageTransmitter (mints by sending native value)
  plus the real `PaymentRouter`, asserting the `InvoicePaid` event, atomic
  revert behaviour, access control, and `rescue`.

## 4. Web: state machine, relayer, API

### DB

New table `bridge_payments` (drizzle):

- `invoiceId` FK, `burnTxHash` (unique), `sourceDomain`, `amount` (6-dec),
- `status`: `burn_submitted → burn_confirmed → attested → paid` | `failed`,
- `mintTxHash` nullable, timestamps, `failureReason` nullable.

`status` here is stored (unlike invoice expiry) because each step is an
external fact we already observed, not a derivable value.

### Libraries

- `web/lib/cctp.ts` — Base Sepolia chain + public client, CCTP addresses and
  domains as config (adding a source chain later = adding one config entry),
  Iris attestation client, and `verifyBurn()`: server-side re-read of the Base
  receipt checking recipient = forwarder, domain = 26, amount = invoice amount.
  A browser-supplied burn txHash is a hint, never trusted (invariant 2 extended
  to the source chain).
- `web/lib/relayer.ts` — wallet client for a new ops key
  (`RELAYER_PRIVATE_KEY`, funded with a little USDC on Arc for gas) that signs
  `mintAndPay`. The merchant still signs nothing.
- `web/lib/bridge.ts` — DB queries + the pure state-machine step function.

### API routes

- `POST /api/invoices/[id]/bridge` — browser reports the burn txHash; server
  runs `verifyBurn()` before inserting the row.
- `GET /api/invoices/[id]/bridge` — browser polls; each call advances the
  state machine **one non-blocking step** (check receipt → query attestation →
  submit `mintAndPay` → hand off to the existing confirm path). No request
  ever waits on the ~60 s attestation; serverless-friendly.
- Cron: extend the existing reconcile pattern to advance bridge payments whose
  browser went away.

Once `mintAndPay` lands, the existing `verify.ts` → invoice-paid path takes
over unchanged; the POS screen beeps via the same `InvoicePaid` watch as today.

### Checkout UI (`/pay/[id]`)

A source selector: **Arc** (existing flow, untouched) or **Base Sepolia**.
The Base path drives wagmi on Base Sepolia (approve, depositForBurn), posts the
burn hash, then renders a progress stepper driven by the poll: *Burned on Base
→ Waiting for Circle attestation (~1 min) → Minting & paying on Arc → Paid*.
Copy tells the customer the page can be closed once the burn is confirmed (the
cron finishes the job).

## 5. Errors and edge cases

- **Wrong burn amount**: `verifyBurn()` rejects; row marked `failed`; funds
  recoverable via `rescue()`.
- **Invoice expires mid-bridge**: payment completes anyway — invariant 4
  already says late money still marks the invoice paid forever.
- **Double mint / replay**: MessageTransmitter nonces prevent on-chain replay;
  the unique `burnTxHash` prevents duplicate rows.
- **Attestation slow or Iris down**: state stays `burn_confirmed`; polling and
  cron retry; UI shows "still bridging".
- **`mintAndPay` reverts**: atomic, message unconsumed, retried by the next
  poll or cron tick.
- **Invoice already paid on Arc while bridging**: the router's settle key
  (`keccak256(invoiceId, merchant, amount)`) makes the duplicate `pay` revert
  with `AlreadySettled`, so `mintAndPay` reverts atomically and the CCTP
  message stays unconsumed. The relayer then calls `rescue()` with `to` = the
  customer's own address (the burn's `depositor` on Base — the same EOA
  address exists on Arc), refunding the bridged USDC directly to the customer.
  The row is marked `failed` with reason `already_settled`.

## 6. Testing

- **Foundry** (`contracts/`): the suite described in §3.
- **Vitest** (`web/`): `verifyBurn()` against fixture logs from a real Base
  Sepolia burn receipt; attestation client with mocked fetch (pending →
  complete → error paths); state-machine transitions as pure functions.
- **Manual E2E on real testnets**: customer wallet funded from the Circle
  faucet (USDC on Base Sepolia) plus Base Sepolia ETH for gas; run the full
  checkout and watch the POS screen beep.

## 7. Out of scope

- Additional source chains (config is ready for them; not wired or tested).
- Fast-transfer (fee-bearing) CCTP mode.
- Permissionless `mintAndPay` via CCTP v2 hook-data parsing (would remove the
  relayer trust assumption; good follow-up).
- On-chain refunds (unchanged, still extension #1).
