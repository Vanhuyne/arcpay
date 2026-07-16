# ArcPay — working notes for Claude

Point-of-sale USDC payments on Arc Chain. Monorepo: `contracts/` (Foundry) + `web/`
(Next.js). Full context: `README.md`, spec `docs/superpowers/specs/2026-07-13-arcpay-mvp-design.md`,
plan `docs/superpowers/plans/2026-07-13-arcpay-mvp.md`. `web/` has its own `AGENTS.md`
(read it before touching Next.js — this is Next 16, not what you remember).

## Commands

```bash
# contracts
cd contracts && forge test                  # 13 tests

# web (run from web/)
pnpm vitest run                             # 68 tests
npx tsc --noEmit                            # typecheck (rm -f tsconfig.tsbuildinfo first if it lies)
pnpm next build                             # prod build — this is what catches type errors CI-style
pnpm dev                                    # localhost:3000
pnpm drizzle-kit push                       # sync schema to Neon
```

Bash cwd persists between calls — `cd web` explicitly; don't assume you're there.

## Invariants — breaking these is a bug, not a style choice

1. **Decimals.** Native (msg.value, gas) is 18-decimal; DB, API, UI are 6-decimal. The
   only place they convert is `web/lib/usdc.ts`. Never multiply/divide by 1e12 anywhere else.
2. **Never trust the client.** A `txHash` from a browser is a hint. `web/lib/verify.ts` is
   the single verifier: it re-reads the receipt from chain and matches invoiceId + merchant
   + amount before any state change. `/api/invoices/[id]/confirm` and `/api/cron/reconcile`
   both call it — do not duplicate verification.
3. **The merchant never signs a tx and never pays gas.** Creating an invoice is a DB insert.
   The merchant signs only the SIWE login message. If you add a merchant-signed tx, it's wrong.
4. **Invoice `expired` is derived, never stored** (`invoiceStatus`); a `paid` invoice stays
   paid forever, even if the money arrived late.
5. English only (code, comments, commits). Conventional Commits. Commit after each unit of work.
6. **CCTP burns are verified server-side.** A `burnTxHash` from a browser is a hint;
   `web/lib/cctp.ts#verifyBurn` re-reads the source-chain receipt and requires
   forwarder recipient + destinationCaller, Arc domain, and exact invoice amount.
   `web/lib/verify.ts` remains the only verifier for Arc-side settlement.
7. **The forwarder never converts decimals.** `CrossPayForwarder` forwards its native
   balance delta; the CCTP burn amount is 6-decimal USDC == `invoice.amount6` (same
   unit, not a conversion). `usdc.ts` stays the only converting module.

## Gotchas that already bit us (don't rediscover them)

- **tsconfig `target` must be ES2020+** — the whole codebase is bigint literals, which need
  it. vitest/esbuild strips types and won't warn; `next build` typechecks and will fail.
- **vitest doesn't load `.env.local`.** `web/vitest.config.ts` loads it via `loadEnv` from
  `'vite'` (not `vitest/config` — v4 dropped it) with an empty prefix, so `NEXT_PUBLIC_*` is
  visible under test. Without it `lib/router.ts` sees no `ROUTER_ADDRESS`.
- **`web/db/index.ts` connects lazily** (a Proxy), so importing the pure helpers in
  `lib/invoices.ts` doesn't require a live `DATABASE_URL`. Keep it that way.
- **Arc RPC caps `eth_getLogs` at 10,000 blocks** (-32614). Page any wider range in chunks
  (see `api/cron/reconcile`).
- **A real Arc receipt carries extra `Transfer` logs** from the native-USDC precompile
  `0xff…fe`, and the router's `InvoicePaid` is not first. `verify.ts` filters by router
  address — that filter is load-bearing, not decoration.
- **SIWE** (`api/auth/*`): the nonce must be the one we issued (httpOnly cookie, single-use)
  and the signature bound to the request host. Verifying only `{message, signature}` is an
  auth bypass (replay + cross-domain).
- **`/api/auth/siwe` sets two Set-Cookie headers** (nonce delete + session). Clients reading
  the session cookie must use `getSetCookie()`, not `.get('set-cookie')`.
- **CCTP v2 event ≠ v1.** `DepositForBurn` v2 has no nonce and ends with `hookData`;
  the Iris v2 API is `GET /v2/messages/{domain}?transactionHash=…` and returns 404
  (not pending) until the burn is indexed. Addresses are identical on every chain.
- **A "standard" CCTP transfer waits for L1 finality.** From Base Sepolia the attestation
  takes ~10–20 minutes (the L2 batch must finalize on Ethereum Sepolia), not the ~1 minute
  marketing suggests. The state machine and UI must tolerate a long `burn_confirmed`.
- **The relayer key (`RELAYER_PRIVATE_KEY`) is ops infrastructure**, not the merchant
  and not the deployer. It needs a little USDC on Arc for `mintAndPay` gas. If bridge
  payments stall at `attested`, check its balance first.
- **Turbopack's `.next` cache can serve stale CSS in dev** after `next build` ran in the
  same tree. If an edit to `globals.css` doesn't show up, `rm -rf .next` and restart dev.
- **vitest writes real rows into the shared Neon DB** (invoices/bridge_payments with
  merchant `0x2222…`). They pile up as stored-`pending`, and the reconcile cron then
  burns ~3 `eth_getLogs` per row until the public Arc RPC quota trips (-32011) and the
  sweep 500s. Purge test debris if the cron starts failing; the sweep now skips
  per-invoice RPC failures instead of dying wholesale.

## Layout

`contracts/src/PaymentRouter.sol` — stateless forwarder (griefing-resistant settle key).
`contracts/src/CrossPayForwarder.sol` — CCTP v2 mint → `router.pay` in one tx, deployed at
`0x8Dc1252663F56dC50583c7edE727193C45347482`. `web/lib/`: `arc.ts` (chain+clients),
`usdc.ts` (the decimals boundary), `router.ts` (ABI+address), `forwarder.ts` (forwarder
ABI+address), `verify.ts` (the verifier), `cctp.ts` (source chains, burn verifier, Iris
client), `bridge.ts` (bridge_payments state machine), `relayer.ts` (ops wallet, mintAndPay),
`invoices.ts` (DB), `session.ts` (SIWE), `dto.ts` (bigints→strings for JSON). Pages:
`app/pay/[id]` (checkout, incl. `bridge-checkout.tsx`), `app/pos/[id]` (merchant QR),
`app/dashboard` (merchant console).

## Environment & secrets

Secrets live in `web/.env.local` and `contracts/.env` — both gitignored, never commit.
`web/.env.example` lists the keys. Chain: Arc Testnet, id `5042002`, native USDC (18 dec).
Deployed `PaymentRouter`: `0x8F560cA651B89FefdcC3273960f9b56BF69EdEaE`. The demo keys are
testnet-only.
