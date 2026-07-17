# Landing Page, Live Demo & App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public homepage with a self-running live payment demo on Arc Testnet, plus site chrome (header, footer, 404/error pages).

**Architecture:** The demo merchant is the relayer address — the ops wallet pays an invoice whose merchant is itself, so a demo run costs only gas. `POST /api/demo` creates a real invoice; the real `/pos/[id]` screen (in `?demo=1` mode) triggers `POST /api/demo/[id]/pay` after ~4.5 s; the server pays via `router.pay` and confirms through the existing `verify.ts`. The landing hero shows a decorative CSS-only receipt animation.

**Tech Stack:** Next 16 App Router, viem, drizzle/Neon, vitest, plain CSS in `app/globals.css` (design tokens already exist).

**Spec:** `docs/superpowers/specs/2026-07-17-landing-and-app-shell-design.md`

## Global Constraints

- All UI copy in English. Conventional Commits. (CLAUDE.md #5)
- Decimals convert **only** in `web/lib/usdc.ts` (#1). Server-side settlement verification **only** via `web/lib/verify.ts` (#2). Merchants never sign txs (#3) — the demo payer is the ops wallet, which is infrastructure. `expired` stays derived (#4).
- No new env vars, keys, chains, or contracts.
- Demo parameters: amount **1.00 USDC** (`1_000_000n`), rate cap **6 per 10 minutes** (DB count), relayer balance floor **5 native USDC** (`5n * 10n ** 18n`), auto-pay delay **4500 ms**.
- `/pos/[id]` and `/pay/[id]` get **no** site header/footer.
- Run all web commands from `web/`. This repo is Next 16 — read `web/AGENTS.md` note; check `node_modules/next/dist/docs/` if unsure about an API.
- Verification commands: `pnpm vitest run`, `pnpm next build` (typechecks), `cd contracts && forge test`.

---

### Task 1: Demo gate logic (`lib/demo.ts`)

Pure decision functions — no chain, no DB — following the injected-deps style of `lib/bridge.ts`.

**Files:**
- Create: `web/lib/demo.ts`
- Test: `web/test/demo.test.ts`

**Interfaces:**
- Consumes: `invoiceStatus(inv, now)` from `@/lib/invoices`, `Invoice` type from `@/db/schema`.
- Produces (used by Task 3):
  - `DEMO_AMOUNT6: bigint`, `DEMO_DESCRIPTION: string`, `DEMO_WINDOW_MS: number`
  - `demoAllowed(input: { recentCount: number; relayerBalance18: bigint }): { ok: true } | { ok: false; reason: 'rate_limited' | 'relayer_low' }`
  - `canAutoPay(invoice: Invoice, demoMerchant: string, now?: Date): { ok: true } | { ok: false; reason: 'not_demo' | 'not_pending' }`

- [ ] **Step 1: Write the failing test**

Create `web/test/demo.test.ts` (fixture style copied from `test/invoices.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { canAutoPay, demoAllowed, DEMO_BALANCE_FLOOR_18, DEMO_MAX_PER_WINDOW } from '@/lib/demo';
import type { Invoice } from '@/db/schema';

const DEMO_MERCHANT = '0x3333333333333333333333333333333333333333';

const base: Invoice = {
  id: '0x01',
  merchant: DEMO_MERCHANT,
  amount6: 1_000_000n,
  description: 'Live demo — one espresso',
  status: 'pending',
  createdAt: new Date('2026-07-17T10:00:00Z'),
  expiresAt: new Date('2026-07-17T10:15:00Z'),
  txHash: null,
  payer: null,
  blockNumber: null,
  gasFee: null,
  paidAt: null,
  wasLate: null,
};

const now = new Date('2026-07-17T10:01:00Z');

describe('demoAllowed', () => {
  const healthy = { recentCount: 0, relayerBalance18: DEMO_BALANCE_FLOOR_18 * 2n };

  it('allows when under the cap and funded', () => {
    expect(demoAllowed(healthy)).toEqual({ ok: true });
  });

  it('refuses at the rate cap', () => {
    expect(demoAllowed({ ...healthy, recentCount: DEMO_MAX_PER_WINDOW })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('refuses below the balance floor — bridge payments need the wallet more', () => {
    expect(demoAllowed({ ...healthy, relayerBalance18: DEMO_BALANCE_FLOOR_18 - 1n })).toEqual({
      ok: false,
      reason: 'relayer_low',
    });
  });

  it('allows exactly at the floor', () => {
    expect(demoAllowed({ ...healthy, relayerBalance18: DEMO_BALANCE_FLOOR_18 })).toEqual({ ok: true });
  });
});

describe('canAutoPay', () => {
  it('pays a pending demo invoice', () => {
    expect(canAutoPay(base, DEMO_MERCHANT, now)).toEqual({ ok: true });
  });

  it('merchant comparison is case-insensitive', () => {
    expect(canAutoPay(base, DEMO_MERCHANT.toUpperCase().replace('0X', '0x'), now)).toEqual({ ok: true });
  });

  it('refuses an invoice that belongs to a real merchant', () => {
    const inv = { ...base, merchant: '0x1111111111111111111111111111111111111111' };
    expect(canAutoPay(inv, DEMO_MERCHANT, now)).toEqual({ ok: false, reason: 'not_demo' });
  });

  it('refuses an already-paid invoice', () => {
    expect(canAutoPay({ ...base, status: 'paid' as const }, DEMO_MERCHANT, now)).toEqual({
      ok: false,
      reason: 'not_pending',
    });
  });

  it('refuses an expired invoice', () => {
    const late = new Date('2026-07-17T10:16:00Z');
    expect(canAutoPay(base, DEMO_MERCHANT, late)).toEqual({ ok: false, reason: 'not_pending' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run test/demo.test.ts`
Expected: FAIL — `Cannot find module '@/lib/demo'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `web/lib/demo.ts`:

```ts
import type { Invoice } from '@/db/schema';
import { invoiceStatus } from '@/lib/invoices';

/**
 * The homepage demo: the ops wallet pays an invoice whose merchant is itself,
 * so a demo run costs only gas. These gates keep strangers from burning it.
 */
export const DEMO_AMOUNT6 = 1_000_000n; // 1.00 USDC
export const DEMO_DESCRIPTION = 'Live demo — one espresso';
export const DEMO_WINDOW_MS = 10 * 60 * 1000;
export const DEMO_MAX_PER_WINDOW = 6;
/** Below this the demo stops: bridge payments need the wallet more. 18-decimal native. */
export const DEMO_BALANCE_FLOOR_18 = 5n * 10n ** 18n;

export type DemoGateResult = { ok: true } | { ok: false; reason: 'rate_limited' | 'relayer_low' };

export function demoAllowed(input: {
  recentCount: number;
  relayerBalance18: bigint;
}): DemoGateResult {
  if (input.recentCount >= DEMO_MAX_PER_WINDOW) return { ok: false, reason: 'rate_limited' };
  if (input.relayerBalance18 < DEMO_BALANCE_FLOOR_18) return { ok: false, reason: 'relayer_low' };
  return { ok: true };
}

export type AutoPayGateResult = { ok: true } | { ok: false; reason: 'not_demo' | 'not_pending' };

/** The pay endpoint may only touch open invoices owned by the demo merchant. */
export function canAutoPay(
  invoice: Invoice,
  demoMerchant: string,
  now: Date = new Date(),
): AutoPayGateResult {
  if (invoice.merchant.toLowerCase() !== demoMerchant.toLowerCase()) {
    return { ok: false, reason: 'not_demo' };
  }
  if (invoiceStatus(invoice, now) !== 'pending') return { ok: false, reason: 'not_pending' };
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/demo.test.ts`
Expected: PASS (9 tests). Then run the whole suite: `pnpm vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add web/lib/demo.ts web/test/demo.test.ts
git commit -m "feat: add demo gate logic — rate cap, balance floor, auto-pay guard"
```

---

### Task 2: Relayer pays an invoice (`lib/relayer.ts`) + explorer address URL

**Files:**
- Modify: `web/lib/relayer.ts`
- Modify: `web/lib/arc.ts` (add `addressUrl` next to `txUrl`)

**Interfaces:**
- Consumes: existing `relayerClient()` (private), `PAYMENT_ROUTER_ABI`/`ROUTER_ADDRESS` from `@/lib/router`, `toNative` from `@/lib/usdc`.
- Produces (used by Tasks 3, 5):
  - `relayerAddress(): Address` — lazy, throws without `RELAYER_PRIVATE_KEY`.
  - `sendRouterPay(invoiceId: Hex, merchant: Address, amount6: bigint): Promise<Hex>` — simulates, sends, waits for inclusion, returns tx hash.
  - `addressUrl(address: string): string` in `@/lib/arc`.

No unit test: this is a thin on-chain wrapper, same policy as the existing `sendMintAndPay`. It is exercised end-to-end in Task 3's manual test and Task 9.

- [ ] **Step 1: Add `relayerAddress` and `sendRouterPay` to `web/lib/relayer.ts`**

Append to the imports:

```ts
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { toNative } from '@/lib/usdc';
```

Append after `relayerClient()`:

```ts
/** The ops wallet's address — also the merchant of homepage demo invoices. */
export function relayerAddress(): Address {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set');
  return privateKeyToAccount(key as Hex).address;
}

/**
 * Pay an invoice from the ops wallet (homepage demo). Simulate first: the
 * router reverts a double-pay deterministically, so a race costs a failed
 * simulation, not gas. Arc blocks are sub-second — waiting keeps callers simple.
 */
export async function sendRouterPay(
  invoiceId: Hex,
  merchant: Address,
  amount6: bigint,
): Promise<Hex> {
  const client = relayerClient();
  const amountNative = toNative(amount6);
  const { request } = await client.simulateContract({
    address: ROUTER_ADDRESS,
    abi: PAYMENT_ROUTER_ABI,
    functionName: 'pay',
    args: [invoiceId, merchant, amountNative],
    value: amountNative,
  });
  const hash = await client.writeContract(request);
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
```

- [ ] **Step 2: Add `addressUrl` to `web/lib/arc.ts`**

Below `txUrl`:

```ts
export function addressUrl(address: string): string {
  return `${ARC_EXPLORER_URL}/address/${address}`;
}
```

- [ ] **Step 3: Typecheck**

Run: `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/lib/relayer.ts web/lib/arc.ts
git commit -m "feat: relayer can pay an invoice via router.pay; explorer address URLs"
```

---

### Task 3: Demo API routes

**Files:**
- Create: `web/app/api/demo/route.ts`
- Create: `web/app/api/demo/[id]/pay/route.ts`

**Interfaces:**
- Consumes: Task 1 (`DEMO_*`, `demoAllowed`, `canAutoPay`), Task 2 (`relayerAddress`, `sendRouterPay`), existing `createInvoice`/`getInvoice`, `verifyPayment`, `toPublicInvoice`, `publicClient`.
- Produces (used by Tasks 4, 6):
  - `POST /api/demo` → `200 { invoiceId, posUrl }` | `429 { error: 'rate_limited' }` | `503 { error: 'relayer_low' }`
  - `POST /api/demo/[id]/pay` → `200 { invoice }` | `404` | `409 { error: 'not_demo' | 'not_pending' }` | `502`

- [ ] **Step 1: Create `web/app/api/demo/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '@/db';
import { invoices } from '@/db/schema';
import { publicClient } from '@/lib/arc';
import { DEMO_AMOUNT6, DEMO_DESCRIPTION, DEMO_WINDOW_MS, demoAllowed } from '@/lib/demo';
import { createInvoice } from '@/lib/invoices';
import { relayerAddress } from '@/lib/relayer';

/**
 * Start a homepage demo: create a real invoice whose merchant is the ops
 * wallet. Unauthenticated by design — the gates below are the protection.
 */
export async function POST(req: Request) {
  const merchant = relayerAddress();

  // Serverless-safe rate cap: count recent demo invoices in the DB instead of
  // keeping in-memory state that each lambda would lose.
  const since = new Date(Date.now() - DEMO_WINDOW_MS);
  const recent = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.merchant, merchant.toLowerCase()), gte(invoices.createdAt, since)));
  const balance = await publicClient.getBalance({ address: merchant });

  const gate = demoAllowed({ recentCount: recent.length, relayerBalance18: balance });
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.reason },
      { status: gate.reason === 'rate_limited' ? 429 : 503 },
    );
  }

  const invoice = await createInvoice({
    merchant,
    amount6: DEMO_AMOUNT6,
    description: DEMO_DESCRIPTION,
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    invoiceId: invoice.id,
    posUrl: `${origin}/pos/${invoice.id}?demo=1`,
  });
}
```

- [ ] **Step 2: Create `web/app/api/demo/[id]/pay/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { Address, Hex } from 'viem';
import { canAutoPay } from '@/lib/demo';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { relayerAddress, sendRouterPay } from '@/lib/relayer';
import { verifyPayment } from '@/lib/verify';

/**
 * The ops wallet pays a demo invoice. Guarded: only pending invoices whose
 * merchant IS the ops wallet — this endpoint cannot be pointed at real
 * invoices, and a double call dies in simulation (router reverts a re-pay).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const gate = canAutoPay(invoice, relayerAddress());
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 409 });

  let hash: Hex;
  try {
    hash = await sendRouterPay(invoice.id as Hex, invoice.merchant as Address, invoice.amount6);
  } catch {
    return NextResponse.json({ error: 'payment failed' }, { status: 502 });
  }

  // Same single verifier as every other settlement path (invariant #2).
  const result = await verifyPayment(invoice, hash);
  if (!result.ok) {
    return NextResponse.json({ error: 'verification failed', reason: result.reason }, { status: 502 });
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({ invoice: toPublicInvoice(fresh!) });
}
```

- [ ] **Step 3: Manual test against dev**

Run: `pnpm dev` (separate terminal), then:

```bash
curl -s -X POST localhost:3000/api/demo | python3 -m json.tool
# Expected: {"invoiceId": "0x…", "posUrl": "http://localhost:3000/pos/0x…?demo=1"}

curl -s -X POST localhost:3000/api/demo/<invoiceId>/pay | python3 -m json.tool
# Expected after ~2s: {"invoice": {..., "status": "paid", "txHash": "0x…"}}
# (spends real testnet gas from the ops wallet — run once, not in a loop)

curl -s -X POST localhost:3000/api/demo/<invoiceId>/pay -o /dev/null -w '%{http_code}\n'
# Expected: 409  (already paid → not_pending)
```

Also verify guard on a real invoice: pick any existing invoice id from the dashboard and `POST /api/demo/<thatId>/pay` → expected 409 `not_demo`.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit` — clean.

```bash
git add web/app/api/demo
git commit -m "feat: demo API — create ops-wallet invoice and auto-pay it on-chain"
```

---

### Task 4: POS screen demo mode

**Files:**
- Modify: `web/app/pos/[id]/page.tsx`
- Modify: `web/app/pos/[id]/pos-screen.tsx`
- Modify: `web/app/globals.css` (demo banner styles)

**Interfaces:**
- Consumes: `POST /api/demo/[id]/pay` (Task 3).
- Produces: `<PosScreen invoice payUrl demo>` — `demo?: boolean` prop; `?demo=1` on the POS URL enables it.

- [ ] **Step 1: Read `demo` from searchParams in `web/app/pos/[id]/page.tsx`**

Replace the component with:

```tsx
export default async function PosPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ demo?: string }>;
}) {
  const { id } = await params;
  const { demo } = await searchParams;
  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  const host = (await headers()).get('host');
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';

  return (
    <PosScreen
      invoice={toPublicInvoice(invoice)}
      payUrl={`${proto}://${host}/pay/${id}`}
      demo={demo === '1'}
    />
  );
}
```

(imports unchanged)

- [ ] **Step 2: Demo banner + auto-pay in `web/app/pos/[id]/pos-screen.tsx`**

Change the signature:

```tsx
export function PosScreen({
  invoice,
  payUrl,
  demo = false,
}: {
  invoice: PublicInvoice;
  payUrl: string;
  demo?: boolean;
}) {
```

Add a third effect after the polling effect (the visitor gets ~4.5 s to see the QR before the ops wallet pays):

```tsx
  // Demo mode: after a beat, ask the server to pay this invoice from the ops
  // wallet. The endpoint re-checks merchant + status server-side; this call is
  // just a trigger, not trusted.
  useEffect(() => {
    if (!demo || status !== 'pending') return;
    const t = setTimeout(() => {
      void fetch(`/api/demo/${invoice.id}/pay`, { method: 'POST' });
    }, 4500);
    return () => clearTimeout(t);
  }, [demo, invoice.id, status]);
```

In the paid branch, after `<p className="pos-paid-amount">…</p>`, add:

```tsx
        {demo && (
          <p className="demo-note">
            That was a real transaction on Arc Testnet.{' '}
            <a href="/">Back to the homepage</a>
          </p>
        )}
```

In the pending branch, right after `<main className="terminal-bg pos">`'s first `<div>` block (before the QR tile), add:

```tsx
      {demo && !expired && (
        <p className="demo-banner">
          <span className="beacon" aria-hidden />
          Live demo — the ops wallet pays this invoice in a few seconds
        </p>
      )}
```

- [ ] **Step 3: Banner styles in `web/app/globals.css`**

Append under the POS section (after `.pos-paid .pos-paid-amount`):

```css
/* ---- homepage demo mode ---- */
.demo-banner {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--paper);
  background: rgba(39, 117, 202, 0.18);
  border: 1px solid rgba(39, 117, 202, 0.45);
  border-radius: 999px;
  padding: 0.4rem 0.9rem;
}
.demo-note {
  margin-top: 1.2rem;
  font-size: 0.85rem;
  opacity: 0.85;
}
.demo-note a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}
```

- [ ] **Step 4: Manual test**

`pnpm dev`, then `curl -s -X POST localhost:3000/api/demo` and open the returned `posUrl` in a browser.
Expected: banner shows, QR visible ~4.5 s, screen flips to PAID with chime, demo note links home. Opening the same URL without `?demo=1` shows no banner and never auto-pays.

- [ ] **Step 5: Commit**

```bash
git add web/app/pos web/app/globals.css
git commit -m "feat: POS demo mode — banner and self-running payment"
```

---

### Task 5: SiteHeader and SiteFooter

**Files:**
- Create: `web/app/site-header.tsx`
- Create: `web/app/site-footer.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- Consumes: `readSession` from `@/lib/session`; `addressUrl` (Task 2), `ROUTER_ADDRESS`, `FORWARDER_ADDRESS`.
- Produces (used by Tasks 6, 7, 8): `<SiteHeader />` (async server component), `<SiteFooter />` (server component).

- [ ] **Step 1: Create `web/app/site-header.tsx`**

```tsx
import Link from 'next/link';
import { readSession } from '@/lib/session';

/** Site chrome for landing + merchant pages. POS/checkout screens never render this. */
export async function SiteHeader() {
  const merchant = await readSession();
  return (
    <header className="site-header">
      <Link href="/" className="wordmark site-wordmark">
        ArcPay
      </Link>
      <nav className="site-nav">
        <Link href="/#how-it-works">How it works</Link>
        <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <Link href="/dashboard" className="site-nav-cta">
          {merchant ? 'Dashboard' : 'Sign in'}
        </Link>
      </nav>
    </header>
  );
}
```

- [ ] **Step 2: Create `web/app/site-footer.tsx`**

```tsx
import { addressUrl } from '@/lib/arc';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { ROUTER_ADDRESS } from '@/lib/router';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>ArcPay · runs on Arc Testnet</p>
      <nav>
        <a href={addressUrl(ROUTER_ADDRESS)} target="_blank" rel="noreferrer">
          PaymentRouter
        </a>
        <a href={addressUrl(FORWARDER_ADDRESS)} target="_blank" rel="noreferrer">
          CrossPayForwarder
        </a>
        <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
    </footer>
  );
}
```

- [ ] **Step 3: Chrome styles in `web/app/globals.css`**

Append a new section:

```css
/* ---- site chrome: header + footer (landing, dashboard, 404) ---- */
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.1rem 1.5rem;
}
.site-wordmark {
  text-decoration: none;
}
.site-nav {
  display: flex;
  align-items: center;
  gap: 1.4rem;
  font-size: 0.9rem;
}
.site-nav a {
  color: var(--label);
  text-decoration: none;
}
.site-nav a:hover {
  color: var(--paper);
}
.site-nav .site-nav-cta {
  color: var(--paper);
  border: 1px solid rgba(251, 250, 247, 0.25);
  border-radius: 999px;
  padding: 0.35rem 0.95rem;
}
.site-nav .site-nav-cta:hover {
  border-color: var(--usdc);
}
.site-nav a:focus-visible {
  outline: 2px solid var(--usdc);
  outline-offset: 3px;
  border-radius: 4px;
}
.site-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.8rem;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.4rem 1.5rem 2rem;
  border-top: 1px solid rgba(251, 250, 247, 0.12);
  font-size: 0.8rem;
  color: var(--label);
}
.site-footer nav {
  display: flex;
  gap: 1.2rem;
}
.site-footer a {
  color: var(--label);
  text-decoration: none;
}
.site-footer a:hover {
  color: var(--paper);
}
```

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit` — clean. (The components render on pages in Tasks 6–8.)

```bash
git add web/app/site-header.tsx web/app/site-footer.tsx web/app/globals.css
git commit -m "feat: site header and footer chrome"
```

---

### Task 6: Landing page

**Files:**
- Modify: `web/app/page.tsx` (full rewrite — the redirect to /dashboard goes away)
- Create: `web/app/try-demo-button.tsx`
- Create: `web/app/hero-receipt.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- Consumes: `POST /api/demo` (Task 3), `<SiteHeader />`/`<SiteFooter />` (Task 5), `addressUrl` (Task 2).
- Produces: the public homepage at `/`.

- [ ] **Step 1: Create `web/app/try-demo-button.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function TryDemoButton() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'creating' | 'unavailable'>('idle');

  async function start() {
    setState('creating');
    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      if (!res.ok) {
        setState('unavailable');
        return;
      }
      const { posUrl } = await res.json();
      router.push(posUrl);
    } catch {
      setState('unavailable');
    }
  }

  return (
    <div className="hero-cta">
      <div className="hero-cta-row">
        <button className="act hero-act" onClick={start} disabled={state === 'creating'}>
          {state === 'creating' ? 'Printing an invoice…' : 'Try a live payment'}
        </button>
        <Link href="/dashboard" className="hero-secondary">
          Open dashboard
        </Link>
      </div>
      {state === 'unavailable' && (
        <p className="hero-note">The demo till is busy right now — try again in a few minutes.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `web/app/hero-receipt.tsx`**

Decorative only — never touches the chain (spec non-goal). Server component, CSS animation.

```tsx
/** Decorative hero: a receipt printing, a QR appearing, PAID landing. CSS-only. */
export function HeroReceipt() {
  return (
    <div className="receipt hero-receipt" aria-hidden>
      <p className="eyebrow hr-item hr-i1">ArcPay · point of sale</p>
      <div className="perf hr-item hr-i1" />
      <p className="hr-desc hr-item hr-i2">Two coffees</p>
      <p className="amount hr-item hr-i2">
        5.00<span className="unit">USDC</span>
      </p>
      <svg className="hr-qr hr-item hr-i3" viewBox="0 0 7 7" role="presentation">
        <rect x="0" y="0" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="1" y="1" width="1" height="1" />
        <rect x="4" y="0" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="5" y="1" width="1" height="1" />
        <rect x="0" y="4" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="1" y="5" width="1" height="1" />
        <rect x="4" y="4" width="1" height="1" />
        <rect x="6" y="4" width="1" height="1" />
        <rect x="5" y="5" width="1" height="1" />
        <rect x="4" y="6" width="1" height="1" />
        <rect x="6" y="6" width="1" height="1" />
      </svg>
      <div className="stamp hr-stamp">PAID</div>
      <p className="hr-time">settled in 0.77s</p>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `web/app/page.tsx`**

```tsx
import type { Metadata } from 'next';
import { addressUrl } from '@/lib/arc';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { ROUTER_ADDRESS } from '@/lib/router';
import { HeroReceipt } from './hero-receipt';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { TryDemoButton } from './try-demo-button';

export const metadata: Metadata = {
  title: 'ArcPay — point-of-sale USDC payments on Arc',
  description:
    'Turn any phone into a USDC till. One signature from the customer, zero gas for the merchant, settled on Arc in under a second.',
};

export default function Home() {
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      <main className="site-main">
        <section className="hero">
          <div>
            <h1>
              Point-of-sale USDC payments.
              <br />
              Settled before the receipt prints.
            </h1>
            <p className="hero-sub">
              ArcPay turns any phone into a USDC till on Arc. The customer signs once, the
              merchant never touches gas, and the counter flips to PAID in under a second.
            </p>
            <TryDemoButton />
          </div>
          <HeroReceipt />
        </section>

        <section className="stats">
          <div className="stat">
            <p className="stat-figure">0.77&thinsp;s</p>
            <p className="stat-label">median on-chain settlement, measured on Arc Testnet</p>
          </div>
          <div className="stat">
            <p className="stat-figure">0 gas</p>
            <p className="stat-label">for merchants — creating an invoice is not a transaction</p>
          </div>
          <div className="stat">
            <p className="stat-figure">no reorgs</p>
            <p className="stat-label">deterministic finality: paid means paid, at the counter</p>
          </div>
        </section>
        <p className="stats-honesty">
          0.77&thinsp;s is chain settlement — submission to PAID. The wall clock a customer sees
          also includes confirming in their wallet; that part is human, not Arc.
        </p>

        <section id="how-it-works" className="how">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <h3>Charge</h3>
              <p>
                The merchant types an amount and taps Charge. ArcPay prints a QR invoice — a
                database row, not a transaction. No wallet, no gas.
              </p>
            </li>
            <li>
              <h3>Scan &amp; sign</h3>
              <p>
                The customer scans, sees the invoice, and signs once. On Arc, gas is USDC too —
                they hold nothing else.
              </p>
            </li>
            <li>
              <h3>Settled</h3>
              <p>
                The router emits InvoicePaid, the server re-verifies it on-chain, and the counter
                flips to PAID — in under a second.
              </p>
            </li>
          </ol>
          <div className="how-bridge">
            <h3>Paying from Base Sepolia?</h3>
            <p>
              ArcPay accepts CCTP v2: burn USDC on Base Sepolia, Circle attests the transfer
              (typically 10–20 minutes for a standard transfer), and the ops wallet mints and pays
              the invoice on Arc. The counter still flips the moment it settles.
            </p>
          </div>
        </section>

        <section className="open">
          <h2>Built in the open</h2>
          <p>
            Every payment settles through two audited-by-you contracts on Arc Testnet.
          </p>
          <ul className="open-list">
            <li>
              <span>PaymentRouter</span>
              <a href={addressUrl(ROUTER_ADDRESS)} target="_blank" rel="noreferrer">
                {ROUTER_ADDRESS}
              </a>
            </li>
            <li>
              <span>CrossPayForwarder</span>
              <a href={addressUrl(FORWARDER_ADDRESS)} target="_blank" rel="noreferrer">
                {FORWARDER_ADDRESS}
              </a>
            </li>
            <li>
              <span>Source</span>
              <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
                github.com/Vanhuyne/arcpay
              </a>
            </li>
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 4: Landing styles in `web/app/globals.css`**

Append:

```css
/* ---- landing page ---- */
.site {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
.site-main {
  flex: 1;
  width: 100%;
  max-width: 64rem;
  margin: 0 auto;
  padding: 0 1.5rem;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 3rem;
  padding: 4.5rem 0 4rem;
}
.hero h1 {
  font-size: clamp(1.9rem, 4.5vw, 3rem);
  line-height: 1.12;
  letter-spacing: -0.02em;
  font-weight: 650;
}
.hero-sub {
  margin-top: 1.1rem;
  max-width: 34rem;
  color: var(--label);
  font-size: 1.05rem;
  line-height: 1.55;
}
.hero-cta {
  margin-top: 2rem;
}
.hero-cta-row {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  flex-wrap: wrap;
}
.hero-act {
  width: auto;
  padding: 0.85rem 1.6rem;
}
.hero-secondary {
  color: var(--paper);
  font-size: 0.95rem;
  text-decoration: none;
  border-bottom: 1px solid rgba(251, 250, 247, 0.35);
  padding-bottom: 2px;
}
.hero-secondary:hover {
  border-color: var(--usdc);
}
.hero-note {
  margin-top: 0.9rem;
  font-size: 0.85rem;
  color: var(--alert);
}

/* hero receipt animation — a 9s loop: print → QR → PAID stamp → settle time */
.hero-receipt {
  max-width: 19rem;
  padding: 1.5rem 1.6rem 2rem;
  text-align: center;
}
.hero-receipt .hr-desc {
  font-size: 0.95rem;
  margin-top: 0.9rem;
}
.hero-receipt .hr-qr {
  width: 7.5rem;
  margin: 1rem auto 0;
  display: block;
  color: var(--body);
}
.hero-receipt .hr-stamp {
  margin: 1.1rem auto 0;
}
.hero-receipt .hr-time {
  font-family: var(--font-space-mono), monospace;
  font-size: 0.8rem;
  color: var(--settle);
  margin-top: 0.5rem;
}
.hr-item, .hr-stamp, .hr-time { opacity: 0; }
.hr-i1 { animation: hr-i1 9s ease infinite; }
.hr-i2 { animation: hr-i2 9s ease infinite; }
.hr-i3 { animation: hr-i3 9s ease infinite; }
.hero-receipt .hr-stamp { animation: hr-stamp 9s ease infinite; }
.hero-receipt .hr-time { animation: hr-time 9s ease infinite; }
@keyframes hr-i1 {
  0%, 3% { opacity: 0; transform: translateY(8px); }
  8%, 92% { opacity: 1; transform: none; }
  97%, 100% { opacity: 0; }
}
@keyframes hr-i2 {
  0%, 9% { opacity: 0; transform: translateY(8px); }
  14%, 92% { opacity: 1; transform: none; }
  97%, 100% { opacity: 0; }
}
@keyframes hr-i3 {
  0%, 16% { opacity: 0; transform: translateY(8px); }
  22%, 92% { opacity: 1; transform: none; }
  97%, 100% { opacity: 0; }
}
@keyframes hr-stamp {
  0%, 50% { opacity: 0; transform: scale(1.7) rotate(-16deg); }
  56%, 92% { opacity: 1; transform: scale(1) rotate(-8deg); }
  97%, 100% { opacity: 0; }
}
@keyframes hr-time {
  0%, 58% { opacity: 0; }
  63%, 92% { opacity: 1; }
  97%, 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .hr-item, .hero-receipt .hr-stamp, .hero-receipt .hr-time {
    animation: none;
    opacity: 1;
    transform: none;
  }
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  padding-top: 1rem;
}
.stat {
  background: var(--ink-2);
  border: 1px solid rgba(251, 250, 247, 0.08);
  border-radius: 12px;
  padding: 1.3rem 1.4rem;
}
.stat-figure {
  font-family: var(--font-space-mono), monospace;
  font-size: 1.7rem;
  color: var(--paper);
}
.stat-label {
  margin-top: 0.4rem;
  font-size: 0.82rem;
  color: var(--label);
  line-height: 1.45;
}
.stats-honesty {
  margin-top: 0.9rem;
  font-size: 0.78rem;
  color: var(--label);
  opacity: 0.8;
}

.how {
  padding: 4rem 0 1rem;
}
.how h2, .open h2 {
  font-size: 1.5rem;
  letter-spacing: -0.01em;
  margin-bottom: 1.6rem;
}
.steps {
  list-style: none;
  counter-reset: step;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.4rem;
}
.steps li {
  counter-increment: step;
}
.steps li::before {
  content: counter(step, decimal-leading-zero);
  font-family: var(--font-space-mono), monospace;
  font-size: 0.8rem;
  color: var(--usdc);
}
.steps h3 {
  margin-top: 0.4rem;
  font-size: 1.05rem;
}
.steps p {
  margin-top: 0.4rem;
  font-size: 0.88rem;
  color: var(--label);
  line-height: 1.5;
}
.how-bridge {
  margin-top: 2.2rem;
  border: 1px dashed rgba(251, 250, 247, 0.2);
  border-radius: 12px;
  padding: 1.2rem 1.4rem;
  max-width: 44rem;
}
.how-bridge h3 {
  font-size: 0.95rem;
}
.how-bridge p {
  margin-top: 0.4rem;
  font-size: 0.85rem;
  color: var(--label);
  line-height: 1.5;
}

.open {
  padding: 3rem 0 4rem;
}
.open > p {
  color: var(--label);
  font-size: 0.9rem;
}
.open-list {
  list-style: none;
  margin-top: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.open-list li {
  display: flex;
  gap: 1rem;
  align-items: baseline;
  font-size: 0.85rem;
}
.open-list span {
  color: var(--label);
  min-width: 10rem;
}
.open-list a {
  font-family: var(--font-space-mono), monospace;
  color: var(--paper);
  text-decoration: none;
  border-bottom: 1px solid rgba(251, 250, 247, 0.25);
  word-break: break-all;
}
.open-list a:hover {
  border-color: var(--usdc);
}

@media (max-width: 760px) {
  .hero {
    grid-template-columns: 1fr;
    padding-top: 3rem;
  }
  .hero-receipt { margin: 0 auto; }
  .stats, .steps { grid-template-columns: 1fr; }
}
```

- [ ] **Step 5: Verify**

Run: `pnpm dev`, open `localhost:3000`.
Expected: landing renders with animated receipt loop; "Try a live payment" navigates to the POS demo (full flow from Task 4); "How it works" anchor scrolls; contract links open the explorer; layout holds at 375 px width.
Run: `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add web/app/page.tsx web/app/try-demo-button.tsx web/app/hero-receipt.tsx web/app/globals.css
git commit -m "feat: landing page with live demo CTA and animated hero receipt"
```

---

### Task 7: 404 and error pages

**Files:**
- Create: `web/app/not-found.tsx`
- Create: `web/app/error.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- Consumes: `<SiteHeader />` (Task 5).
- Produces: global 404 + error boundary in the receipt language.

- [ ] **Step 1: Create `web/app/not-found.tsx`**

```tsx
import Link from 'next/link';
import { SiteHeader } from './site-header';

export default function NotFound() {
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      <main className="jam">
        <div className="receipt jam-receipt">
          <p className="eyebrow">ArcPay · lost receipt</p>
          <div className="perf" />
          <h1 className="jam-title">RECEIPT NOT FOUND</h1>
          <p className="jam-text">
            This page never printed. Check the URL, or head back to the counter.
          </p>
          <Link href="/" className="jam-link">
            Back to the homepage
          </Link>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/app/error.tsx`**

Error boundaries must be client components; `reset()` retries the segment.

```tsx
'use client';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="terminal-bg site">
      <main className="jam">
        <div className="receipt jam-receipt">
          <p className="eyebrow">ArcPay · malfunction</p>
          <div className="perf" />
          <h1 className="jam-title">SOMETHING JAMMED THE PRINTER</h1>
          <p className="jam-text">An unexpected error stopped this page. It was not your fault.</p>
          <button className="act jam-act" onClick={reset}>
            Try again
          </button>
        </div>
      </main>
    </div>
  );
}
```

(No `SiteHeader` here: the error boundary must not depend on server components that could themselves be the failure.)

- [ ] **Step 3: Styles in `web/app/globals.css`**

Append:

```css
/* ---- 404 / error: the jammed printer ---- */
.jam {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1.5rem;
}
.jam-receipt {
  max-width: 22rem;
  text-align: center;
  padding: 1.6rem 1.6rem 2rem;
}
.jam-title {
  font-family: var(--font-space-mono), monospace;
  font-size: 1.15rem;
  letter-spacing: 0.04em;
  margin-top: 1rem;
  color: var(--alert);
}
.jam-text {
  margin-top: 0.7rem;
  font-size: 0.88rem;
  color: var(--label);
  line-height: 1.5;
}
.jam-link {
  display: inline-block;
  margin-top: 1.2rem;
  font-size: 0.9rem;
  color: var(--usdc-deep);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.jam-act {
  margin-top: 1.2rem;
  width: auto;
  padding: 0.7rem 1.4rem;
}
```

- [ ] **Step 4: Verify**

Run: `pnpm dev`, open `localhost:3000/pos/0xdeadbeef` (unknown invoice → `notFound()`) and `localhost:3000/nonsense`.
Expected: the lost-receipt page renders with header and home link.

- [ ] **Step 5: Commit**

```bash
git add web/app/not-found.tsx web/app/error.tsx web/app/globals.css
git commit -m "feat: receipt-styled 404 and error pages"
```

---

### Task 8: Dashboard wears the site header

The spec puts the shell on landing + dashboard. The dashboard's `console-head` currently repeats the wordmark; the header owns it now.

**Files:**
- Modify: `web/app/dashboard/page.tsx`
- Modify: `web/app/dashboard/dashboard.tsx`
- Modify: `web/app/dashboard/sign-in.tsx`

**Interfaces:**
- Consumes: `<SiteHeader />` (Task 5).
- Produces: no API changes; visual only.

- [ ] **Step 1: Wrap both states in `web/app/dashboard/page.tsx`**

```tsx
import { readSession } from '@/lib/session';
import { SiteHeader } from '../site-header';
import { Dashboard } from './dashboard';
import { SignIn } from './sign-in';

export default async function DashboardPage() {
  const merchant = await readSession();
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      {merchant ? <Dashboard merchant={merchant} /> : <SignIn />}
    </div>
  );
}
```

- [ ] **Step 2: Drop the duplicated chrome inside the states**

In `web/app/dashboard/dashboard.tsx`: change the outer `<main className="terminal-bg" style={{ minHeight: '100dvh' }}>` to `<main>` (the wrapper now owns background and height), and remove the line `<p className="wordmark">ArcPay</p>` from `console-head` (keep the `who` span — the header shows no address).

In `web/app/dashboard/sign-in.tsx`: change `<main className="terminal-bg signin">` to `<main className="signin">` and remove `<p className="wordmark">ArcPay</p>` (keep the tagline).

- [ ] **Step 3: Check the layout in dev**

Run: `pnpm dev`, open `/dashboard` signed out and signed in.
Expected: one wordmark (header), sign-out still works, header shows "Dashboard" when signed in. `.console-head` with only `who` should right-align — if it collapses left, add `justify-content: flex-end` to `.console-head` in `globals.css`.

- [ ] **Step 4: Commit**

```bash
git add web/app/dashboard
git commit -m "feat: dashboard and sign-in wear the site header"
```

---

### Task 9: Full verification

- [ ] **Step 1: Full test suite and build**

```bash
cd web && pnpm vitest run          # expected: all pass (69 existing + 9 demo)
rm -f tsconfig.tsbuildinfo && pnpm next build   # expected: clean build, / listed as static or dynamic without errors
cd ../contracts && forge test      # expected: 13 pass
```

- [ ] **Step 2: End-to-end demo flow on dev**

`pnpm dev`, then walk: `/` → Try a live payment → POS banner + QR → auto-PAID with chime → "Back to the homepage". Then `/dashboard` (both auth states), `/nonsense` (404). Click every landing link once (anchor, GitHub, explorer × 2, footer).

- [ ] **Step 3: Rate-cap sanity check (no gas spent)**

After the one demo run above, `curl -s -X POST localhost:3000/api/demo` repeatedly until it returns 429 (≤ 6 calls — creating invoices costs nothing; do NOT call `/pay` on them). Confirm 429 body is `{"error":"rate_limited"}`.

- [ ] **Step 4: Commit any fixes; final commit if the tree is dirty**

```bash
git status   # expect clean, or commit stragglers with a conventional message
```
