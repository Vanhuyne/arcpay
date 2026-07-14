# ArcPay

A point-of-sale payment gateway on **Arc Chain** where a customer scans a QR, pays with
USDC in one signature, and the merchant's screen flips to **PAID** in under a second.

**Live:** <https://arcpay-theta.vercel.app>

## Why Arc, and not Base or Polygon

On every other EVM chain, paying with USDC still requires the customer to hold a *second*
token — ETH, MATIC — to cover gas. A coffee shop and its customers will never do that.

On Arc, **gas *is* USDC**: the customer needs exactly one asset in their wallet. Combined
with sub-second deterministic finality (Malachite BFT, no reorgs), "paid" genuinely means
paid, right at the counter. Two more Arc facts the design leans on directly:

- **EIP-7708** — every native USDC movement emits a `Transfer` log, so detecting a payment
  is just listening to logs, not scanning every transaction in a block.
- **Sub-second finality** — a transaction can be treated as final at the counter, with no
  "wait for N confirmations".

## Measured on Arc Testnet

- **Chain finality (submit → final): ~0.77s** typical, 0.75s min, over 5 real payments.
- **Gas per payment: 0.0011 USDC** (~a tenth of a cent), paid by the customer, in USDC.
- **Merchant gas: zero.** Creating an invoice is a database insert; the merchant signs only
  a login message and never a transaction.

Full evidence, the real demo transaction, and the spec §11 criteria checklist are in
[`docs/demo-metrics.md`](docs/demo-metrics.md). A note on honesty: the end-to-end wall
clock a person sees (tap Pay → PAID) is longer than 0.77s because it includes the seconds
spent confirming in the wallet — that is human time, not Arc's. The 0.77s is the chain
settlement the "under a second" claim is about.

## How it works

A stateless [`PaymentRouter`](contracts/src/PaymentRouter.sol) forwards native USDC to the
merchant and emits `InvoicePaid`. Invoices live in Postgres, never on-chain. Payment
detection has three independent paths — the customer's checkout tab, the merchant's POS
WebSocket watch, and a cron sweep — that all funnel into **one** server-side verifier
([`web/lib/verify.ts`](web/lib/verify.ts)) which re-reads the receipt from the chain and
matches `invoiceId`, `merchant`, and `amount` against the database row. A `txHash` posted
by a browser is only ever a hint; nothing in it is trusted.

All 18-decimal (native) ↔ 6-decimal (ERC-20 / DB / UI) conversion happens in exactly one
file, [`web/lib/usdc.ts`](web/lib/usdc.ts).

## Run it locally

Prerequisites: [pnpm](https://pnpm.io), [Foundry](https://getfoundry.sh), a
[Neon](https://neon.tech) Postgres URL, and an Arc Testnet wallet funded from
<https://faucet.circle.com>.

```bash
# contracts
cd contracts && forge test               # 7 tests

# web
cd ../web && pnpm install
cp .env.example .env.local               # then fill in the values below
pnpm drizzle-kit push                     # create the schema in Neon
pnpm vitest run                           # 43 tests
pnpm dev                                  # http://localhost:3000
```

`web/.env.local` needs:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_ROUTER_ADDRESS` | deployed `PaymentRouter` (below) |
| `DATABASE_URL` | Neon Postgres |
| `SESSION_SECRET` | JWT key for SIWE sessions (≥32 bytes) |
| `CRON_SECRET` | bearer guarding `/api/cron/reconcile` |
| `NEXT_PUBLIC_ARC_RPC_HTTP` / `_WS` | optional; default to Arc Testnet public RPC |

The reconciler cron runs daily on Vercel Hobby (Pro allows per-minute); it is a safety net,
not a detection path, and can always be invoked directly.

## Deployed contract

`PaymentRouter` on Arc Testnet (chain `5042002`):
[`0x8F560cA651B89FefdcC3273960f9b56BF69EdEaE`](https://testnet.arcscan.app/address/0x8F560cA651B89FefdcC3273960f9b56BF69EdEaE)

## Stack

Foundry (Solidity 0.8.24) · Next.js App Router + TypeScript · viem / wagmi · Drizzle ORM +
Neon Postgres · Vitest · Vercel.
