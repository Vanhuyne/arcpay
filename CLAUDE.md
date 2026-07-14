# ArcPay — working notes for Claude

Point-of-sale USDC payments on Arc Chain. Monorepo: `contracts/` (Foundry) + `web/`
(Next.js). Full context: `README.md`, spec `docs/superpowers/specs/2026-07-13-arcpay-mvp-design.md`,
plan `docs/superpowers/plans/2026-07-13-arcpay-mvp.md`. `web/` has its own `AGENTS.md`
(read it before touching Next.js — this is Next 16, not what you remember).

## Commands

```bash
# contracts
cd contracts && forge test                  # 7 tests

# web (run from web/)
pnpm vitest run                             # 43 tests
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

## Layout

`contracts/src/PaymentRouter.sol` — the only contract (stateless forwarder; griefing-resistant
settle key). `web/lib/`: `arc.ts` (chain+clients), `usdc.ts` (the decimals boundary),
`router.ts` (ABI+address), `verify.ts` (the verifier), `invoices.ts` (DB), `session.ts` (SIWE),
`dto.ts` (bigints→strings for JSON). Pages: `app/pay/[id]` (checkout), `app/pos/[id]` (merchant
QR), `app/dashboard` (merchant console).

## Environment & secrets

Secrets live in `web/.env.local` and `contracts/.env` — both gitignored, never commit.
`web/.env.example` lists the keys. Chain: Arc Testnet, id `5042002`, native USDC (18 dec).
Deployed `PaymentRouter`: `0x8F560cA651B89FefdcC3273960f9b56BF69EdEaE`. The demo keys are
testnet-only.
