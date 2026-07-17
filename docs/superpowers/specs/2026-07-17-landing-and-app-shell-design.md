# Landing page, live demo, and app shell — design

**Date:** 2026-07-17
**Status:** approved by user (brainstorm session)

## Goal

Make ArcPay read as a real product, demo-first: a public homepage whose centerpiece
is a **self-running live payment demo** on Arc Testnet, plus the app shell (header,
footer, 404/error pages) that stops the app feeling like three disconnected screens.
This lays the visual foundation for later merchant-facing pages.

## Non-goals

- No merchant onboarding, docs site, receipt page, or dashboard redesign (later iterations).
- No embedded/inline demo widget on the homepage — the demo navigates to the real
  `/pos/[id]` screen. The hero receipt animation is decorative, CSS-only, never on-chain.
- No new chains, contracts, or env vars.

## Pages & app shell

- `/` becomes the landing page (today it redirects to `/dashboard`; the redirect goes away).
- New `SiteHeader`: ArcPay wordmark, "How it works" (anchor link), GitHub link; on the
  right, "Sign in" or "Dashboard" depending on the SIWE session (read server-side via
  `readSession`). Used on landing and dashboard.
- New `SiteFooter`: GitHub, Arc Testnet explorer links for both deployed contracts
  (PaymentRouter `0x8F56…dEaE`, CrossPayForwarder `0x8Dc1…7482`), "Runs on Arc Testnet".
- `/pos/[id]` and `/pay/[id]` deliberately keep **no** site chrome — they are
  customer-facing terminal screens.
- Global `not-found.tsx` and `error.tsx` styled in the existing receipt language
  (torn receipt, "RECEIPT NOT FOUND" / "SOMETHING JAMMED THE PRINTER").
- All copy in English.

## Live demo mechanics

The demo merchant **is the relayer address**: the ops wallet pays an invoice whose
merchant is itself, so each demo run costs only gas — no USDC leaves the wallet.
No new keys or env vars.

- `POST /api/demo` (unauthenticated): creates a real invoice
  (merchant = relayer address, small fixed amount, e.g. 1.00 USDC, description
  marking it as a demo). Returns `{ invoiceId, posUrl }`; the client navigates to
  `/pos/[id]?demo=1`, which renders the normal POS screen plus a
  "live testnet demo" banner.
- Auto-pay: in demo mode the POS screen waits ~4–5 s (so the visitor sees the QR),
  then calls `POST /api/demo/[id]/pay`. The server pays on-chain via the relayer
  wallet (`router.pay`, msg.value from `usdc.ts` conversion) and then confirms
  through the existing `verify.ts` path — the single-verifier invariant holds;
  no verification logic is duplicated.
- The POS screen observes the invoice flip to `paid` exactly as it would for a
  real payment, settlement stopwatch included.

### Abuse guards (`/api/demo/*`)

Serverless-safe, no new infrastructure:

1. `pay` only accepts invoices whose merchant is the relayer address, still
   `pending`, and not expired; it pays each invoice at most once.
2. Global rate cap: refuse `POST /api/demo` when more than N demo invoices
   (merchant = relayer) were created in the last 10 minutes — a DB count, not
   in-memory state. N tunable, default 6.
3. Refuse when the relayer balance is below a floor, so the demo cannot drain
   the wallet that bridge payments depend on.

Demo invoices end up `paid`, so the reconcile cron never sweeps them (it only
scans stored-`pending` rows) — no repeat of the test-debris incident.

## Landing page content

All sections sit on the existing `terminal-bg` backdrop, in scroll order:

1. **Hero** — headline ("Point-of-sale USDC payments. Settled before the receipt
   prints." or similar), one-line sub. CTAs: **Try a live payment** (primary,
   USDC blue) and Open dashboard (secondary). Right side: decorative receipt card
   animating on a CSS keyframe loop — invoice prints → QR appears → PAID stamp
   lands with the settle time. Reuses `.receipt` styles.
2. **Real numbers** — three stats from `docs/demo-metrics.md`: **0.77 s** chain
   settlement · **0 gas** for merchants (customer signs once) · **no reorgs**
   (deterministic finality at the counter). Copy stays honest: 0.77 s is on-chain
   settlement, not the human wall clock.
3. **How it works** — three steps (create invoice → customer scans QR → settled
   on-chain), plus a smaller block for "Pay from Base Sepolia" (CCTP v2) that
   states the honest ~20-minute attestation time.
4. **Built in the open** — both contract addresses linked to the Arc explorer,
   GitHub link, "Arc Testnet" badge.
5. **Footer** — SiteFooter.

## Testing

- Demo gate logic (rate-window decision, demo-merchant check, balance floor)
  is factored as pure functions with injected deps — the `AdvanceDeps` pattern
  from `lib/bridge` — and unit-tested in vitest with no chain or DB.
- Existing suite and `pnpm next build` stay green (CI enforces).
- Manual end-to-end on dev: landing → Try a live payment → POS QR → auto-paid →
  stopwatch; 404/error pages; header reflects signed-in state.

## Invariants respected

- Decimals convert only in `usdc.ts` (#1). Server-side verification only through
  `verify.ts` (#2). The **merchant** still never signs or pays gas — the demo payer
  is the ops wallet, which is infrastructure, not a merchant (#3). `expired` stays
  derived (#4). English only (#5).
