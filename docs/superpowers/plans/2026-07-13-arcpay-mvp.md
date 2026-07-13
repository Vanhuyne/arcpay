# ArcPay MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a point-of-sale payment gateway on Arc Chain where a customer scans a QR, pays with USDC in one signature, and the merchant's screen flips to PAID in under a second.

**Architecture:** A stateless `PaymentRouter` Solidity contract forwards native USDC to the merchant and emits `InvoicePaid`. Invoices live in Postgres, never on-chain. Payment detection has three independent paths (customer tab, merchant POS WebSocket watch, cron sweep) that all funnel into one idempotent server-side verifier that re-derives truth from the chain via RPC — so the client is never trusted and no long-running indexer exists.

**Tech Stack:** Foundry (Solidity 0.8.24) · Next.js App Router + TypeScript · viem 2.55+ / wagmi · Drizzle ORM + Neon Postgres · Vitest · Vercel

**Reference spec:** `docs/superpowers/specs/2026-07-13-arcpay-mvp-design.md`

## Global Constraints

- **Decimals are law.** Database, APIs and UI use **6-decimal integers** (`amount6`). Anything touching the chain uses **18-decimal bigint**. Conversion happens in **`web/lib/usdc.ts` and nowhere else**. No other file may multiply or divide by `1e12`. This is merge-blocking.
- **Never trust the client.** A `txHash` posted by a browser is a *hint*. Payment state changes only after `lib/verify.ts` re-reads the receipt from the chain and matches all three of `invoiceId`, `merchant`, `amount` against the database row.
- **The merchant never signs and never pays gas.** Creating an invoice is a database INSERT. If any task introduces a merchant-signed transaction, it is wrong.
- **One verifier.** `lib/verify.ts` is shared by `/confirm` and `/cron/reconcile`. Never duplicate verification logic.
- **All project artifacts are English** — code, comments, README, commit messages.
- **Chain:** Arc Testnet, chain id `5042002`, imported as `arcTestnet` from `viem/chains` (verified present in viem 2.55.1). Native currency: USDC, 18 decimals.
- **Package manager:** pnpm.
- **Commit after every task.** Conventional commits (`feat:`, `test:`, `chore:`).

---

## File Structure

```
arcpay/
├─ contracts/                        Foundry project
│  ├─ foundry.toml
│  ├─ src/PaymentRouter.sol           the only contract
│  ├─ test/PaymentRouter.t.sol        incl. the anti-griefing test
│  └─ script/Deploy.s.sol
└─ web/                              Next.js App Router
   ├─ lib/
   │  ├─ arc.ts                       chain + viem clients (HTTP, WS)
   │  ├─ usdc.ts                      THE ONLY decimals conversion
   │  ├─ router.ts                    PaymentRouter ABI + address
   │  ├─ verify.ts                    the single verifier (Task 6)
   │  ├─ session.ts                   SIWE session cookie (Task 7)
   │  └─ invoices.ts                  DB queries (Task 5)
   ├─ db/schema.ts                    Drizzle schema
   ├─ app/
   │  ├─ api/auth/nonce/route.ts
   │  ├─ api/auth/siwe/route.ts
   │  ├─ api/invoices/route.ts             POST create, GET list
   │  ├─ api/invoices/[id]/route.ts        GET public read
   │  ├─ api/invoices/[id]/confirm/route.ts
   │  ├─ api/cron/reconcile/route.ts
   │  ├─ pay/[id]/page.tsx            customer checkout — heart of the demo
   │  ├─ pos/[id]/page.tsx            merchant full-screen QR
   │  └─ dashboard/page.tsx           merchant invoices + revenue
   └─ test/                           Vitest
```

Each `lib/` module has one responsibility and is unit-testable without a browser or a database. UI pages are thin: they call the API and render.

---

## Task 1: Scaffold the monorepo and pin the Arc chain config

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`
- Create: `contracts/foundry.toml`
- Create: `web/` (via `create-next-app`)
- Create: `web/lib/arc.ts`
- Create: `web/vitest.config.ts`
- Test: `web/test/arc.test.ts`

**Interfaces:**
- Produces: `arcTestnet` (re-exported), `publicClient` (viem `PublicClient` over HTTP), `ARC_EXPLORER_URL: string`, `createWsClient(): PublicClient` from `web/lib/arc.ts`.

- [ ] **Step 1: Scaffold the workspace**

```bash
cd /Users/vanhuy/Desktop/arc
mkdir -p contracts/src contracts/test contracts/script
printf 'packages:\n  - "web"\n' > pnpm-workspace.yaml
pnpm create next-app@latest web --ts --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm --yes
cd web && pnpm add viem@^2.55.1 wagmi @tanstack/react-query && pnpm add -D vitest tsx
```

`tsx` is a dev dependency because several verification steps in this plan run one-off
TypeScript scripts against the live testnet (`pnpm tsx -e "…"`).

- [ ] **Step 2: Write the failing test**

This test guards against a future viem upgrade silently changing the chain under us. The `decimals: 18` assertion is the tripwire for the entire decimals convention.

Create `web/test/arc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ARC_EXPLORER_URL, arcTestnet } from '@/lib/arc';

describe('arc chain config', () => {
  it('is Arc Testnet', () => {
    expect(arcTestnet.id).toBe(5042002);
  });

  it('uses USDC as native currency with 18 decimals', () => {
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC');
    expect(arcTestnet.nativeCurrency.decimals).toBe(18);
  });

  it('points at ArcScan', () => {
    expect(ARC_EXPLORER_URL).toBe('https://testnet.arcscan.app');
  });
});
```

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/arc.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/arc"`.

- [ ] **Step 4: Implement `web/lib/arc.ts`**

```ts
import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { arcTestnet } from 'viem/chains';

export { arcTestnet };

export const ARC_EXPLORER_URL = 'https://testnet.arcscan.app';

const RPC_HTTP = process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network';
const RPC_WS = process.env.NEXT_PUBLIC_ARC_RPC_WS ?? 'wss://rpc.testnet.arc.network';

/** Server-side reads: receipts, logs. */
export const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_HTTP),
});

/** Browser-side event subscription for the POS screen. */
export function createWsClient(): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: webSocket(RPC_WS) });
}

export function txUrl(hash: string): string {
  return `${ARC_EXPLORER_URL}/tx/${hash}`;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/arc.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Prove the RPC is actually reachable**

This is a live network check, not a unit test. Run it once by hand; do not add it to the test suite (it would make CI depend on a testnet).

```bash
cd web && pnpm tsx -e "
import { publicClient } from './lib/arc';
const n = await publicClient.getBlockNumber();
console.log('Arc testnet block:', n);
"
```
Expected: a block number prints. If this fails, try a fallback RPC (`https://rpc.blockdaemon.testnet.arc.network`) before proceeding — every later task depends on it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold monorepo and pin Arc Testnet chain config"
```

---

## Task 2: The decimals boundary (`lib/usdc.ts`)

This is the highest-risk code in the project and the smallest. It gets written first, alone, with tests that encode the exact failure mode we fear.

**Files:**
- Create: `web/lib/usdc.ts`
- Test: `web/test/usdc.test.ts`

**Interfaces:**
- Produces: `USDC_SCALE: bigint`, `toNative(amount6: bigint): bigint`, `fromNative(wei: bigint): bigint`, `formatUsdc(amount6: bigint): string`, `formatNativeUsdc(wei: bigint, precision?: number): string`, `parseUsdc(input: string): bigint` from `web/lib/usdc.ts`.

`formatNativeUsdc` exists so that UI code displaying an 18-decimal value (the gas fee) never has to divide by `1e18` itself. Without it, the dashboard would have to do the conversion inline — which the Global Constraints forbid.

- [ ] **Step 1: Write the failing test**

Create `web/test/usdc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatNativeUsdc, formatUsdc, fromNative, parseUsdc, toNative, USDC_SCALE } from '@/lib/usdc';

describe('usdc decimals boundary', () => {
  it('scales by exactly 10^12 (18 - 6)', () => {
    expect(USDC_SCALE).toBe(10n ** 12n);
  });

  it('converts 5 USDC from 6-decimal storage to 18-decimal native', () => {
    expect(toNative(5_000_000n)).toBe(5_000_000_000_000_000_000n);
  });

  it('round-trips without loss', () => {
    for (const a of [0n, 1n, 5_000_000n, 999_999_999_999n]) {
      expect(fromNative(toNative(a))).toBe(a);
    }
  });

  it('truncates native dust below 1 micro-USDC to zero', () => {
    // Arc's ERC-20 view drops sub-6-decimal precision. We must behave the same way
    // or a payment that "looks" correct on chain will mismatch our record.
    expect(fromNative(999_999_999_999n)).toBe(0n);
  });

  it('formats 6-decimal amounts for display', () => {
    expect(formatUsdc(5_000_000n)).toBe('5.00');
    expect(formatUsdc(1_234_567n)).toBe('1.234567');
    expect(formatUsdc(0n)).toBe('0.00');
  });

  it('formats an 18-decimal native amount (the gas fee) without losing precision', () => {
    // The dashboard must never do this division itself with Number().
    expect(formatNativeUsdc(10_000_000_000_000_000n)).toBe('0.0100');
    expect(formatNativeUsdc(8_432_000_000_000_000n)).toBe('0.0084');
    expect(formatNativeUsdc(0n)).toBe('0.0000');
  });

  it('parses user input into 6-decimal integers', () => {
    expect(parseUsdc('5')).toBe(5_000_000n);
    expect(parseUsdc('5.00')).toBe(5_000_000n);
    expect(parseUsdc('0.01')).toBe(10_000n);
  });

  it('rejects input with more than 6 decimal places', () => {
    expect(() => parseUsdc('1.1234567')).toThrow();
  });

  it('rejects non-positive amounts', () => {
    expect(() => parseUsdc('0')).toThrow();
    expect(() => parseUsdc('-1')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/usdc.test.ts`
Expected: FAIL — cannot resolve `@/lib/usdc`.

- [ ] **Step 3: Implement `web/lib/usdc.ts`**

```ts
/**
 * The single boundary between Arc's two views of USDC.
 *
 * Native (msg.value, gas): 18 decimals.
 * ERC-20 interface, our database, our API, our UI: 6 decimals.
 *
 * Same balance, two representations. No other file in this project may
 * convert between them.
 */
export const USDC_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;
export const USDC_SCALE = 10n ** BigInt(NATIVE_DECIMALS - USDC_DECIMALS); // 10^12

/** 6-decimal storage amount -> 18-decimal native amount (msg.value). */
export function toNative(amount6: bigint): bigint {
  return amount6 * USDC_SCALE;
}

/** 18-decimal native amount -> 6-decimal storage amount. Truncates dust. */
export function fromNative(wei: bigint): bigint {
  return wei / USDC_SCALE;
}

/** "5.00", "1.234567" — for display only. */
export function formatUsdc(amount6: bigint): string {
  const whole = amount6 / 1_000_000n;
  const frac = amount6 % 1_000_000n;
  if (frac === 0n) return `${whole}.00`;
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

/**
 * Format an 18-decimal native amount (gas fees) for display, e.g. "0.0084".
 * UI code must call this instead of dividing by 1e18 — Number() on an 18-decimal
 * bigint silently loses precision, which is the exact class of bug this module exists
 * to prevent.
 */
export function formatNativeUsdc(wei: bigint, precision = 4): string {
  const scale = 10n ** BigInt(NATIVE_DECIMALS - precision);
  const scaled = wei / scale;
  const whole = scaled / 10n ** BigInt(precision);
  const frac = scaled % 10n ** BigInt(precision);
  return `${whole}.${frac.toString().padStart(precision, '0')}`;
}

/** User input -> 6-decimal integer. Throws on anything we refuse to guess about. */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: ${input} (max 6 decimal places)`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const amount6 = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (amount6 <= 0n) throw new Error('Amount must be greater than zero');
  return amount6;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/usdc.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add usdc decimals boundary, the only place 18<->6 conversion happens"
```

---

## Task 3: `PaymentRouter` contract and its tests

The griefing test in Step 1 is the most important test in this repository. It proves the design decision from spec section 4.2.

**Files:**
- Create: `contracts/foundry.toml`
- Create: `contracts/src/PaymentRouter.sol`
- Test: `contracts/test/PaymentRouter.t.sol`

**Interfaces:**
- Produces: `PaymentRouter.pay(bytes32 invoiceId, address merchant, uint256 amount) payable`, event `InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount, uint64 timestamp)`, and public getter `settled(bytes32) -> bool`.

- [ ] **Step 1: Initialise Foundry and write the failing tests**

```bash
cd contracts && forge init --no-git --no-commit --force .
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
```

Create `contracts/foundry.toml`:

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
```

Create `contracts/test/PaymentRouter.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// @dev A merchant that tries to re-enter the router when it receives funds.
contract ReentrantMerchant {
    PaymentRouter private immutable router;
    bytes32 private immutable invoiceId;
    uint256 private immutable amount;
    bool private entered;

    constructor(PaymentRouter r, bytes32 id, uint256 amt) {
        router = r;
        invoiceId = id;
        amount = amt;
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            router.pay{value: amount}(invoiceId, address(this), amount);
        }
    }
}

contract PaymentRouterTest is Test {
    PaymentRouter private router;

    address private merchant = makeAddr("merchant");
    address private payer = makeAddr("payer");
    address private griefer = makeAddr("griefer");

    bytes32 private constant INVOICE = bytes32(uint256(0xA11CE));
    uint256 private constant AMOUNT = 500e18; // 500 USDC, native 18-decimal

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 timestamp
    );

    function setUp() public {
        router = new PaymentRouter();
        vm.deal(payer, 1000e18);
        vm.deal(griefer, 1000e18);
    }

    function test_ForwardsFundsAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit InvoicePaid(INVOICE, merchant, payer, AMOUNT, uint64(block.timestamp));

        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);

        assertEq(merchant.balance, AMOUNT, "merchant received funds");
        assertEq(address(router).balance, 0, "router holds nothing");
    }

    function test_RevertWhen_ValueDoesNotMatchAmount() public {
        vm.prank(payer);
        vm.expectRevert(PaymentRouter.AmountMismatch.selector);
        router.pay{value: AMOUNT - 1}(INVOICE, merchant, AMOUNT);
    }

    function test_RevertWhen_MerchantIsZeroAddress() public {
        vm.prank(payer);
        vm.expectRevert(PaymentRouter.InvalidMerchant.selector);
        router.pay{value: AMOUNT}(INVOICE, address(0), AMOUNT);
    }

    function test_RevertWhen_SameTripleIsReplayed() public {
        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);

        vm.prank(payer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT);
    }

    /// The single most important test in this repo.
    /// A griefer paying a dust amount against our invoiceId must NOT be able to
    /// mark it settled and thereby block the real customer's payment.
    function test_GrieferCannotBlockRealPayment() public {
        uint256 dust = 0.01e18;

        vm.prank(griefer);
        router.pay{value: dust}(INVOICE, griefer, dust); // different (id, merchant, amount) key

        vm.prank(payer);
        router.pay{value: AMOUNT}(INVOICE, merchant, AMOUNT); // must still succeed

        assertEq(merchant.balance, AMOUNT, "real payment went through untouched");
    }

    function test_RevertWhen_MerchantReentersRouter() public {
        ReentrantMerchant evil = new ReentrantMerchant(router, INVOICE, AMOUNT);
        vm.deal(payer, 2 * AMOUNT);

        vm.prank(payer);
        vm.expectRevert(PaymentRouter.ForwardFailed.selector);
        router.pay{value: AMOUNT}(INVOICE, address(evil), AMOUNT);

        assertEq(address(evil).balance, 0, "reentrancy extracted nothing");
    }
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd contracts && forge test`
Expected: FAIL — `Source "src/PaymentRouter.sol" not found`.

- [ ] **Step 3: Implement `contracts/src/PaymentRouter.sol`**

```solidity
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd contracts && forge test -vv`
Expected: PASS — 6 tests, including `test_GrieferCannotBlockRealPayment`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add PaymentRouter with griefing-resistant settle key"
```

---

## Task 4: Deploy to Arc Testnet and wire `lib/router.ts`

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Create: `contracts/.env.example`
- Create: `web/lib/router.ts`
- Create: `web/.env.local` (not committed)
- Test: `web/test/router.test.ts`

**Interfaces:**
- Produces: `PAYMENT_ROUTER_ABI` (viem-typed const), `ROUTER_ADDRESS: Address`, `INVOICE_PAID_EVENT` (the ABI item) from `web/lib/router.ts`.

- [ ] **Step 1: Write the deploy script**

Create `contracts/script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        PaymentRouter router = new PaymentRouter();
        vm.stopBroadcast();
        console.log("PaymentRouter deployed at:", address(router));
    }
}
```

Create `contracts/.env.example`:

```
ARC_RPC_URL=https://rpc.testnet.arc.network
DEPLOYER_PRIVATE_KEY=0x...
```

- [ ] **Step 2: Fund the deployer and deploy**

Get testnet USDC for the deployer address from https://faucet.circle.com (Arc Testnet). Gas is paid in USDC — the deployer needs a small balance and nothing else.

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```
Expected: `PaymentRouter deployed at: 0x...`. Confirm the contract on https://testnet.arcscan.app. Record the address.

- [ ] **Step 3: Write the failing test**

Create `web/test/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAbiItem, isAddress } from 'viem';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';

describe('payment router binding', () => {
  it('exposes a deployed router address', () => {
    expect(isAddress(ROUTER_ADDRESS)).toBe(true);
  });

  it('exposes pay(bytes32,address,uint256) as payable', () => {
    const pay = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'pay' });
    expect(pay?.stateMutability).toBe('payable');
    expect(pay?.inputs.map((i) => i.type)).toEqual(['bytes32', 'address', 'uint256']);
  });

  it('exposes the InvoicePaid event with three indexed fields', () => {
    const ev = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'InvoicePaid' });
    expect(ev?.inputs.filter((i) => 'indexed' in i && i.indexed)).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/router.test.ts`
Expected: FAIL — cannot resolve `@/lib/router`.

- [ ] **Step 5: Implement `web/lib/router.ts` and set the env var**

Write the deployed address into `web/.env.local`:

```
NEXT_PUBLIC_ROUTER_ADDRESS=0x<address from Step 2>
```

Create `web/lib/router.ts`:

```ts
import { getAbiItem, type Address } from 'viem';

export const PAYMENT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'payable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'merchant', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settled',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'InvoicePaid',
    inputs: [
      { name: 'invoiceId', type: 'bytes32', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
] as const;

export const INVOICE_PAID_EVENT = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'InvoicePaid' });

export const ROUTER_ADDRESS = process.env.NEXT_PUBLIC_ROUTER_ADDRESS as Address;

if (!ROUTER_ADDRESS) {
  throw new Error('NEXT_PUBLIC_ROUTER_ADDRESS is not set — deploy the contract first');
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/router.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: deploy PaymentRouter to Arc Testnet and bind its ABI"
```

---

## Task 5: Database schema and invoice queries

**Files:**
- Create: `web/db/schema.ts`
- Create: `web/db/index.ts`
- Create: `web/drizzle.config.ts`
- Create: `web/lib/invoices.ts`
- Test: `web/test/invoices.test.ts`

**Interfaces:**
- Produces from `web/db/schema.ts`: tables `merchants`, `invoices`; type `Invoice` (the row type).
- Produces from `web/lib/invoices.ts`: `newInvoiceId(): Hex`, `createInvoice(input: { merchant: Address; amount6: bigint; description: string }): Promise<Invoice>`, `getInvoice(id: string): Promise<Invoice | null>`, `listInvoices(merchant: Address): Promise<Invoice[]>`, `markPaid(id: string, receipt: PaidReceipt): Promise<void>`, `listPending(): Promise<Invoice[]>`, `invoiceStatus(inv: Invoice, now?: Date): 'pending' | 'paid' | 'expired'` (`now` defaults to `new Date()`; injectable so status is testable without faking the clock).
- Type `PaidReceipt = { txHash: Hex; payer: Address; blockNumber: bigint; gasFee: bigint; paidAt: Date; wasLate: boolean }`.

- [ ] **Step 1: Provision Neon Postgres**

```bash
cd web
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D drizzle-kit
vercel link
vercel integration add neon
vercel env pull .env.local
```
Expected: `.env.local` now contains `DATABASE_URL`.

- [ ] **Step 2: Write the failing test**

`invoiceStatus` is pure — test it without a database. The database-backed functions are exercised end-to-end in Task 13.

Create `web/test/invoices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { invoiceStatus, newInvoiceId } from '@/lib/invoices';
import type { Invoice } from '@/db/schema';

const base: Invoice = {
  id: '0x01',
  merchant: '0x1111111111111111111111111111111111111111',
  amount6: 5_000_000n,
  description: 'Two coffees',
  status: 'pending',
  createdAt: new Date('2026-07-13T10:00:00Z'),
  expiresAt: new Date('2026-07-13T10:15:00Z'),
  txHash: null,
  payer: null,
  blockNumber: null,
  paidAt: null,
  gasFee: null,
  wasLate: false,
};

describe('newInvoiceId', () => {
  it('returns an unguessable 32-byte hex string', () => {
    const id = newInvoiceId();
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newInvoiceId()).not.toBe(id);
  });
});

describe('invoiceStatus', () => {
  it('is pending before expiry', () => {
    expect(invoiceStatus(base, new Date('2026-07-13T10:05:00Z'))).toBe('pending');
  });

  it('is expired past expiresAt while still unpaid', () => {
    expect(invoiceStatus(base, new Date('2026-07-13T10:20:00Z'))).toBe('expired');
  });

  it('is paid once settled, even long after expiry', () => {
    // Money arrived. It does not matter that the clock ran out.
    const paid: Invoice = { ...base, status: 'paid', wasLate: true };
    expect(invoiceStatus(paid, new Date('2026-07-14T00:00:00Z'))).toBe('paid');
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/invoices.test.ts`
Expected: FAIL — cannot resolve `@/lib/invoices`.

- [ ] **Step 4: Implement the schema**

Create `web/db/schema.ts`:

```ts
import { boolean, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const merchants = pgTable('merchants', {
  address: text('address').primaryKey(), // lowercase; checksummed only for display
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(), // random 32-byte hex, used directly as bytes32
  merchant: text('merchant').notNull(),
  amount6: numeric('amount6', { mode: 'bigint' }).notNull(), // 6 decimals — see lib/usdc.ts
  description: text('description').notNull(),
  status: text('status', { enum: ['pending', 'paid'] }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  // populated only by lib/verify.ts
  txHash: text('tx_hash'),
  payer: text('payer'),
  blockNumber: numeric('block_number', { mode: 'bigint' }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  gasFee: numeric('gas_fee', { mode: 'bigint' }), // 18 decimals — the "fee paid in USDC" story
  wasLate: boolean('was_late').notNull().default(false),
});

export type Invoice = typeof invoices.$inferSelect;
```

Create `web/db/index.ts`:

```ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
```

Create `web/drizzle.config.ts`:

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

- [ ] **Step 5: Implement `web/lib/invoices.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { db } from '@/db';
import { invoices, type Invoice } from '@/db/schema';

const INVOICE_TTL_MS = 15 * 60 * 1000;

export type PaidReceipt = {
  txHash: Hex;
  payer: Address;
  blockNumber: bigint;
  gasFee: bigint;
  paidAt: Date;
  wasLate: boolean;
};

/** 32 random bytes: unguessable, and usable directly as the contract's bytes32. */
export function newInvoiceId(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * 'expired' is derived, never stored: an invoice that expires is not written to.
 * A paid invoice stays paid forever, even if the money arrived after the deadline.
 */
export function invoiceStatus(inv: Invoice, now: Date = new Date()): 'pending' | 'paid' | 'expired' {
  if (inv.status === 'paid') return 'paid';
  return now > inv.expiresAt ? 'expired' : 'pending';
}

export async function createInvoice(input: {
  merchant: Address;
  amount6: bigint;
  description: string;
}): Promise<Invoice> {
  const [row] = await db
    .insert(invoices)
    .values({
      id: newInvoiceId(),
      merchant: input.merchant.toLowerCase(),
      amount6: input.amount6,
      description: input.description,
      expiresAt: new Date(Date.now() + INVOICE_TTL_MS),
    })
    .returning();
  return row;
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return row ?? null;
}

export async function listInvoices(merchant: Address): Promise<Invoice[]> {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.merchant, merchant.toLowerCase()))
    .orderBy(desc(invoices.createdAt));
}

export async function listPending(): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.status, 'pending'));
}

/** Only lib/verify.ts may call this. Guarded by status so it is idempotent. */
export async function markPaid(id: string, receipt: PaidReceipt): Promise<void> {
  await db
    .update(invoices)
    .set({
      status: 'paid',
      txHash: receipt.txHash,
      payer: receipt.payer.toLowerCase(),
      blockNumber: receipt.blockNumber,
      gasFee: receipt.gasFee,
      paidAt: receipt.paidAt,
      wasLate: receipt.wasLate,
    })
    .where(and(eq(invoices.id, id), eq(invoices.status, 'pending')));
}
```

- [ ] **Step 6: Push the schema and run the test**

```bash
cd web && pnpm drizzle-kit push
pnpm vitest run test/invoices.test.ts
```
Expected: schema pushed to Neon; 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add invoice schema and queries with derived expiry"
```

---

## Task 6: The verifier (`lib/verify.ts`)

The entire security model of the product is this one function. It gets its own task and the most thorough tests in the web codebase.

**Files:**
- Create: `web/lib/verify.ts`
- Test: `web/test/verify.test.ts`

**Interfaces:**
- Consumes: `publicClient` (Task 1), `toNative` (Task 2), `PAYMENT_ROUTER_ABI` / `ROUTER_ADDRESS` (Task 4), `Invoice` / `markPaid` (Task 5).
- Produces: `verifyPayment(invoice: Invoice, txHash: Hex, client?: PublicClient): Promise<VerifyResult>` where
  `type VerifyResult = { ok: true; alreadyPaid: boolean } | { ok: false; reason: VerifyFailure }` and
  `type VerifyFailure = 'no_receipt' | 'tx_reverted' | 'no_router_log' | 'invoice_mismatch' | 'merchant_mismatch' | 'amount_mismatch'`.

- [ ] **Step 1: Write the failing test**

Create `web/test/verify.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, type Hex, type PublicClient } from 'viem';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { verifyPayment } from '@/lib/verify';
import type { Invoice } from '@/db/schema';

vi.mock('@/lib/invoices', () => ({ markPaid: vi.fn().mockResolvedValue(undefined) }));

const MERCHANT = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const TX: Hex = `0x${'ab'.repeat(32)}`;

const invoice: Invoice = {
  id: `0x${'01'.repeat(32)}`,
  merchant: MERCHANT,
  amount6: 5_000_000n, // 5 USDC
  description: 'Two coffees',
  status: 'pending',
  createdAt: new Date('2026-07-13T10:00:00Z'),
  expiresAt: new Date('2026-07-13T10:15:00Z'),
  txHash: null,
  payer: null,
  blockNumber: null,
  paidAt: null,
  gasFee: null,
  wasLate: false,
};

/** Build a log that looks exactly like a real InvoicePaid emission. */
function invoicePaidLog(opts: {
  address?: string;
  invoiceId?: Hex;
  merchant?: string;
  amountNative?: bigint;
}) {
  const topics = encodeEventTopics({
    abi: PAYMENT_ROUTER_ABI,
    eventName: 'InvoicePaid',
    args: {
      invoiceId: opts.invoiceId ?? (invoice.id as Hex),
      merchant: (opts.merchant ?? MERCHANT) as `0x${string}`,
      payer: PAYER,
    },
  });
  const amount = opts.amountNative ?? 5_000_000_000_000_000_000n; // 5 USDC in 18 decimals
  const data = `0x${amount.toString(16).padStart(64, '0')}${(1752400000n).toString(16).padStart(64, '0')}` as Hex;
  return { address: opts.address ?? ROUTER_ADDRESS, topics, data };
}

function clientReturning(receipt: unknown): PublicClient {
  return { getTransactionReceipt: vi.fn().mockResolvedValue(receipt) } as unknown as PublicClient;
}

const goodReceipt = {
  status: 'success',
  blockNumber: 12345n,
  gasUsed: 50_000n,
  effectiveGasPrice: 20_000_000_000n,
  logs: [invoicePaidLog({})],
};

describe('verifyPayment', () => {
  it('accepts a genuine payment', async () => {
    const res = await verifyPayment(invoice, TX, clientReturning(goodReceipt));
    expect(res).toEqual({ ok: true, alreadyPaid: false });
  });

  it('rejects a fabricated txHash with no receipt', async () => {
    const client = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not found')) };
    const res = await verifyPayment(invoice, TX, client as unknown as PublicClient);
    expect(res).toEqual({ ok: false, reason: 'no_receipt' });
  });

  it('rejects a reverted transaction', async () => {
    const res = await verifyPayment(invoice, TX, clientReturning({ ...goodReceipt, status: 'reverted' }));
    expect(res).toEqual({ ok: false, reason: 'tx_reverted' });
  });

  it('rejects a log emitted by a contract other than the router', async () => {
    const receipt = { ...goodReceipt, logs: [invoicePaidLog({ address: OTHER })] };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'no_router_log' });
  });

  it("rejects a receipt that pays a different invoice", async () => {
    const receipt = { ...goodReceipt, logs: [invoicePaidLog({ invoiceId: `0x${'99'.repeat(32)}` })] };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'invoice_mismatch' });
  });

  it('rejects a payment routed to a different merchant', async () => {
    const receipt = { ...goodReceipt, logs: [invoicePaidLog({ merchant: OTHER })] };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'merchant_mismatch' });
  });

  it('rejects an amount that does not match the invoice exactly', async () => {
    const receipt = { ...goodReceipt, logs: [invoicePaidLog({ amountNative: 4_999_999_999_999_999_999n })] };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('is idempotent: an already-paid invoice verifies without rewriting', async () => {
    const paid: Invoice = { ...invoice, status: 'paid', txHash: TX };
    const res = await verifyPayment(paid, TX, clientReturning(goodReceipt));
    expect(res).toEqual({ ok: true, alreadyPaid: true });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/verify.test.ts`
Expected: FAIL — cannot resolve `@/lib/verify`.

- [ ] **Step 3: Implement `web/lib/verify.ts`**

```ts
import { decodeEventLog, type Hex, type PublicClient } from 'viem';
import { publicClient } from '@/lib/arc';
import { markPaid } from '@/lib/invoices';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { toNative } from '@/lib/usdc';
import type { Invoice } from '@/db/schema';

export type VerifyFailure =
  | 'no_receipt'
  | 'tx_reverted'
  | 'no_router_log'
  | 'invoice_mismatch'
  | 'merchant_mismatch'
  | 'amount_mismatch';

export type VerifyResult =
  | { ok: true; alreadyPaid: boolean }
  | { ok: false; reason: VerifyFailure };

/**
 * The single source of truth for "was this invoice paid?".
 *
 * `txHash` is a HINT supplied by an untrusted browser. Nothing in it is believed.
 * We re-read the receipt from the chain and require the emitted InvoicePaid log to
 * match this invoice on all three fields before any state changes.
 */
export async function verifyPayment(
  invoice: Invoice,
  txHash: Hex,
  client: PublicClient = publicClient,
): Promise<VerifyResult> {
  if (invoice.status === 'paid') return { ok: true, alreadyPaid: true };

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: 'no_receipt' };
  }
  if (!receipt) return { ok: false, reason: 'no_receipt' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };

  const routerLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === ROUTER_ADDRESS.toLowerCase(),
  );

  let decoded: { invoiceId: Hex; merchant: Hex; payer: Hex; amount: bigint } | null = null;
  for (const log of routerLogs) {
    try {
      const ev = decodeEventLog({
        abi: PAYMENT_ROUTER_ABI,
        eventName: 'InvoicePaid',
        topics: log.topics,
        data: log.data,
      });
      decoded = ev.args as typeof decoded;
      break;
    } catch {
      // not an InvoicePaid log — keep looking
    }
  }
  if (!decoded) return { ok: false, reason: 'no_router_log' };

  if (decoded.invoiceId.toLowerCase() !== invoice.id.toLowerCase()) {
    return { ok: false, reason: 'invoice_mismatch' };
  }
  if (decoded.merchant.toLowerCase() !== invoice.merchant.toLowerCase()) {
    return { ok: false, reason: 'merchant_mismatch' };
  }
  if (decoded.amount !== toNative(invoice.amount6)) {
    return { ok: false, reason: 'amount_mismatch' };
  }

  const paidAt = new Date();
  await markPaid(invoice.id, {
    txHash,
    payer: decoded.payer,
    blockNumber: receipt.blockNumber,
    gasFee: receipt.gasUsed * receipt.effectiveGasPrice, // 18 decimals, native USDC
    paidAt,
    // Money arrived after the deadline. Record it as paid anyway — refusing to
    // acknowledge funds we actually received is worse than a late invoice.
    wasLate: paidAt > invoice.expiresAt,
  });

  return { ok: true, alreadyPaid: false };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/verify.test.ts`
Expected: PASS — 8 tests. Every forgery in spec section 10.2 is rejected.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add the payment verifier, the single source of truth"
```

---

## Task 7: SIWE authentication

**Files:**
- Create: `web/lib/session.ts`
- Create: `web/app/api/auth/nonce/route.ts`
- Create: `web/app/api/auth/siwe/route.ts`
- Test: `web/test/session.test.ts`

**Interfaces:**
- Produces from `web/lib/session.ts`: `signSession(address: string): Promise<string>` (pure — signs a JWT, no cookie), `verifySessionToken(token: string): Promise<string | null>` (pure — returns the lowercased address or `null`), `createSession(address: Address): Promise<void>` (sets the httpOnly cookie), `readSession(): Promise<Address | null>` (reads it), `SESSION_COOKIE = 'arcpay_session'`.
- The pure pair (`signSession` / `verifySessionToken`) exists so session security is unit-testable without a Next.js request context.

- [ ] **Step 1: Install dependencies**

```bash
cd web && pnpm add jose
```

- [ ] **Step 2: Write the failing test**

Create `web/test/session.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { signSession, verifySessionToken } from '@/lib/session';

const ADDRESS = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-at-least-32-bytes-long!!';
});

describe('session token', () => {
  it('round-trips the merchant address', async () => {
    const token = await signSession(ADDRESS);
    expect(await verifySessionToken(token)).toBe(ADDRESS.toLowerCase());
  });

  it('rejects a tampered token', async () => {
    const token = await signSession(ADDRESS);
    const tampered = `${token.slice(0, -4)}aaaa`;
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySessionToken('not-a-jwt')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/session.test.ts`
Expected: FAIL — cannot resolve `@/lib/session`.

- [ ] **Step 4: Implement `web/lib/session.ts`**

```ts
import { cookies } from 'next/headers';
import { jwtVerify, SignJWT } from 'jose';
import type { Address } from 'viem';

export const SESSION_COOKIE = 'arcpay_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(s);
}

export async function signSession(address: string): Promise<string> {
  return new SignJWT({ sub: address.toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

export async function createSession(address: Address): Promise<void> {
  const token = await signSession(address);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

/** The merchant address for the current request, or null if not signed in. */
export async function readSession(): Promise<Address | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const sub = await verifySessionToken(token);
  return (sub as Address) ?? null;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/session.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Implement the SIWE routes**

Create `web/app/api/auth/nonce/route.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ nonce: randomBytes(16).toString('hex') });
}
```

Create `web/app/api/auth/siwe/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { parseSiweMessage } from 'viem/siwe';
import { publicClient } from '@/lib/arc';
import { createSession } from '@/lib/session';

export async function POST(req: Request) {
  const { message, signature } = await req.json();

  const parsed = parseSiweMessage(message);
  if (!parsed.address) {
    return NextResponse.json({ error: 'malformed message' }, { status: 400 });
  }

  const valid = await publicClient.verifySiweMessage({ message, signature });
  if (!valid) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  await createSession(parsed.address);
  return NextResponse.json({ address: parsed.address });
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add SIWE login — the wallet is the merchant account"
```

---

## Task 8: Invoice API routes

**Files:**
- Create: `web/app/api/invoices/route.ts`
- Create: `web/app/api/invoices/[id]/route.ts`
- Create: `web/app/api/invoices/[id]/confirm/route.ts`
- Create: `web/lib/dto.ts`
- Test: `web/test/dto.test.ts`

**Interfaces:**
- Consumes: `createInvoice`, `getInvoice`, `listInvoices`, `invoiceStatus` (Task 5); `verifyPayment` (Task 6); `readSession` (Task 7); `parseUsdc`, `formatUsdc` (Task 2).
- Produces from `web/lib/dto.ts`: `toPublicInvoice(inv: Invoice, now?: Date): PublicInvoice` where
  `type PublicInvoice = { id: string; merchant: Address; amount6: string; amountDisplay: string; description: string; status: 'pending' | 'paid' | 'expired'; expiresAt: string; txHash: string | null; payer: string | null; gasFee: string | null; paidAt: string | null }`.

`amount6` and `gasFee` are serialised as **strings**, because `bigint` is not JSON-representable and silently losing precision here would be exactly the bug the decimals convention exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `web/test/dto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toPublicInvoice } from '@/lib/dto';
import type { Invoice } from '@/db/schema';

const inv: Invoice = {
  id: '0xabc',
  merchant: '0x1111111111111111111111111111111111111111',
  amount6: 5_000_000n,
  description: 'Two coffees',
  status: 'pending',
  createdAt: new Date('2026-07-13T10:00:00Z'),
  expiresAt: new Date('2026-07-13T10:15:00Z'),
  txHash: null,
  payer: null,
  blockNumber: null,
  paidAt: null,
  gasFee: null,
  wasLate: false,
};

describe('toPublicInvoice', () => {
  it('serialises bigints as strings, never as numbers', () => {
    const dto = toPublicInvoice(inv, new Date('2026-07-13T10:05:00Z'));
    expect(dto.amount6).toBe('5000000');
    expect(typeof dto.amount6).toBe('string');
  });

  it('exposes a display amount for the UI', () => {
    const dto = toPublicInvoice(inv, new Date('2026-07-13T10:05:00Z'));
    expect(dto.amountDisplay).toBe('5.00');
  });

  it('derives expired status at read time', () => {
    const dto = toPublicInvoice(inv, new Date('2026-07-13T10:20:00Z'));
    expect(dto.status).toBe('expired');
  });

  it('never leaks internal columns', () => {
    const dto = toPublicInvoice(inv, new Date('2026-07-13T10:05:00Z'));
    expect(dto).not.toHaveProperty('wasLate');
    expect(dto).not.toHaveProperty('blockNumber');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd web && pnpm vitest run test/dto.test.ts`
Expected: FAIL — cannot resolve `@/lib/dto`.

- [ ] **Step 3: Implement `web/lib/dto.ts`**

```ts
import type { Address } from 'viem';
import { invoiceStatus } from '@/lib/invoices';
import { formatUsdc } from '@/lib/usdc';
import type { Invoice } from '@/db/schema';

export type PublicInvoice = {
  id: string;
  merchant: Address;
  amount6: string; // string, not number: bigint precision must survive JSON
  amountDisplay: string;
  description: string;
  status: 'pending' | 'paid' | 'expired';
  expiresAt: string;
  txHash: string | null;
  payer: string | null;
  gasFee: string | null;
  paidAt: string | null;
};

export function toPublicInvoice(inv: Invoice, now: Date = new Date()): PublicInvoice {
  return {
    id: inv.id,
    merchant: inv.merchant as Address,
    amount6: inv.amount6.toString(),
    amountDisplay: formatUsdc(inv.amount6),
    description: inv.description,
    status: invoiceStatus(inv, now),
    expiresAt: inv.expiresAt.toISOString(),
    txHash: inv.txHash,
    payer: inv.payer,
    gasFee: inv.gasFee?.toString() ?? null,
    paidAt: inv.paidAt?.toISOString() ?? null,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd web && pnpm vitest run test/dto.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement the routes**

Create `web/app/api/invoices/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { toPublicInvoice } from '@/lib/dto';
import { createInvoice, listInvoices } from '@/lib/invoices';
import { readSession } from '@/lib/session';
import { parseUsdc } from '@/lib/usdc';

export async function POST(req: Request) {
  const merchant = await readSession();
  if (!merchant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { amount, description } = await req.json();

  let amount6: bigint;
  try {
    amount6 = parseUsdc(String(amount));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const invoice = await createInvoice({
    merchant,
    amount6,
    description: String(description ?? '').slice(0, 200),
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    invoice: toPublicInvoice(invoice),
    payUrl: `${origin}/pay/${invoice.id}`,
  });
}

export async function GET() {
  const merchant = await readSession();
  if (!merchant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await listInvoices(merchant);
  const now = new Date();
  const paid = rows.filter((r) => r.status === 'paid');
  const revenue6 = paid.reduce((sum, r) => sum + r.amount6, 0n);

  return NextResponse.json({
    invoices: rows.map((r) => toPublicInvoice(r, now)),
    revenue6: revenue6.toString(),
  });
}
```

Create `web/app/api/invoices/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';

// Public on purpose: the customer has no account, and an invoice is only
// reachable by knowing its random 32-byte id.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ invoice: toPublicInvoice(invoice) });
}
```

Create `web/app/api/invoices/[id]/confirm/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { verifyPayment } from '@/lib/verify';

/**
 * The browser tells us a txHash. We believe none of it — verifyPayment goes
 * back to the chain and checks the emitted event against our own record.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { txHash } = await req.json();

  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: 'invalid txHash' }, { status: 400 });
  }

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const result = await verifyPayment(invoice, txHash as Hex);
  if (!result.ok) {
    return NextResponse.json({ error: 'verification failed', reason: result.reason }, { status: 400 });
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({ invoice: toPublicInvoice(fresh!) });
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add invoice create/read/confirm API routes"
```

---

## Task 9: Customer checkout page (`/pay/[id]`)

The heart of the demo. Every element on this page exists to prove one claim: the customer holds only USDC and signs exactly once.

**Files:**
- Create: `web/app/providers.tsx`
- Modify: `web/app/layout.tsx`
- Create: `web/app/pay/[id]/page.tsx`
- Create: `web/app/pay/[id]/checkout.tsx`
- Create: `web/lib/wagmi.ts`

**Interfaces:**
- Consumes: `PublicInvoice` (Task 8), `PAYMENT_ROUTER_ABI` / `ROUTER_ADDRESS` (Task 4), `toNative` (Task 2), `arcTestnet` / `txUrl` (Task 1).

- [ ] **Step 1: Configure wagmi**

Create `web/lib/wagmi.ts`:

```ts
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { arcTestnet } from '@/lib/arc';

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network'),
  },
  ssr: true,
});
```

Create `web/app/providers.tsx`:

```tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { wagmiConfig } from '@/lib/wagmi';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
```

Wrap `web/app/layout.tsx`'s `<body>` children in `<Providers>`.

- [ ] **Step 2: Implement the checkout component**

Create `web/app/pay/[id]/checkout.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConnect, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import type { Hex } from 'viem';
import { arcTestnet, txUrl } from '@/lib/arc';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { toNative } from '@/lib/usdc';
import { wagmiConfig } from '@/lib/wagmi';
import type { PublicInvoice } from '@/lib/dto';

type Phase = 'idle' | 'signing' | 'confirming' | 'paid' | 'error';

export function Checkout({ invoice }: { invoice: PublicInvoice }) {
  const { isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>(invoice.status === 'paid' ? 'paid' : 'idle');
  const [txHash, setTxHash] = useState<Hex | null>(invoice.txHash as Hex | null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wrongChain = isConnected && chainId !== arcTestnet.id;

  useEffect(() => {
    if (wrongChain) switchChain({ chainId: arcTestnet.id });
  }, [wrongChain, switchChain]);

  async function pay() {
    setError(null);
    setPhase('signing');
    const startedAt = performance.now();

    try {
      const amountNative = toNative(BigInt(invoice.amount6));

      const hash = await writeContractAsync({
        address: ROUTER_ADDRESS,
        abi: PAYMENT_ROUTER_ABI,
        functionName: 'pay',
        args: [invoice.id as Hex, invoice.merchant, amountNative],
        value: amountNative, // gas is USDC too — the customer holds nothing else
      });

      setTxHash(hash);
      setPhase('confirming');

      await waitForTransactionReceipt(wagmiConfig, { hash });
      setElapsedMs(Math.round(performance.now() - startedAt));

      // A hint to the server; it will re-verify against the chain itself.
      await fetch(`/api/invoices/${invoice.id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: hash }),
      });

      setPhase('paid');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'paid') {
    return (
      <div className="text-center">
        <div className="text-6xl">✅</div>
        <h1 className="mt-4 text-2xl font-semibold">Paid</h1>
        <p className="mt-1 text-neutral-500">{invoice.amountDisplay} USDC · {invoice.description}</p>
        {elapsedMs !== null && (
          <p className="mt-4 text-sm text-neutral-500">Final in {(elapsedMs / 1000).toFixed(2)}s</p>
        )}
        {txHash && (
          <a className="mt-2 inline-block text-sm underline" href={txUrl(txHash)} target="_blank" rel="noreferrer">
            View on ArcScan
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <p className="text-sm text-neutral-500">{invoice.description}</p>
      <p className="mt-1 text-5xl font-semibold tabular-nums">{invoice.amountDisplay}<span className="ml-2 text-2xl text-neutral-400">USDC</span></p>

      {invoice.status === 'expired' && (
        <p className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
          This invoice has expired. Ask the merchant for a new one.
        </p>
      )}

      {!isConnected ? (
        <button
          className="mt-8 w-full rounded-lg bg-black py-4 font-medium text-white"
          onClick={() => connect({ connector: connectors[0] })}
        >
          Connect wallet
        </button>
      ) : (
        <button
          className="mt-8 w-full rounded-lg bg-black py-4 font-medium text-white disabled:opacity-40"
          disabled={phase === 'signing' || phase === 'confirming' || invoice.status === 'expired'}
          onClick={pay}
        >
          {phase === 'signing' ? 'Confirm in your wallet…'
            : phase === 'confirming' ? 'Settling…'
            : `Pay ${invoice.amountDisplay} USDC`}
        </button>
      )}

      <p className="mt-4 text-center text-xs text-neutral-400">
        Gas is paid in USDC. No other token required.
      </p>

      <a className="mt-2 block text-center text-xs underline text-neutral-400" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
        Need testnet USDC?
      </a>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Implement the page**

Create `web/app/pay/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { Checkout } from './checkout';

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Checkout invoice={toPublicInvoice(invoice)} />
    </main>
  );
}
```

- [ ] **Step 4: Verify it renders and pays**

```bash
cd web && pnpm dev
```
Create an invoice by hand against the running dev server (sign in first at `/dashboard` once Task 11 exists; until then, insert a row directly with `pnpm drizzle-kit studio`), then open `/pay/<id>` in a browser with a funded Arc Testnet wallet and complete a real payment.

Expected: one signature; success screen shows an elapsed time under 1 second and a working ArcScan link.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add customer checkout — one signature, USDC only"
```

---

## Task 10: Merchant POS screen (`/pos/[id]`)

**Files:**
- Create: `web/app/pos/[id]/page.tsx`
- Create: `web/app/pos/[id]/pos-screen.tsx`

**Interfaces:**
- Consumes: `PublicInvoice` (Task 8), `createWsClient` (Task 1), `PAYMENT_ROUTER_ABI` / `ROUTER_ADDRESS` (Task 4).

The screen runs **two independent detection paths**, exactly as the spec requires: a WebSocket event watch that survives the customer's tab closing, and a poll of our own API, which is the authoritative source.

- [ ] **Step 1: Install the QR renderer**

```bash
cd web && pnpm add qrcode.react
```

- [ ] **Step 2: Implement the POS screen**

Create `web/app/pos/[id]/pos-screen.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Hex } from 'viem';
import { createWsClient } from '@/lib/arc';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import type { PublicInvoice } from '@/lib/dto';

export function PosScreen({ invoice, payUrl }: { invoice: PublicInvoice; payUrl: string }) {
  const [status, setStatus] = useState(invoice.status);

  // Path 1: watch the chain directly. Independent of the customer's browser —
  // if they pay and immediately close the tab, we still see it.
  useEffect(() => {
    if (status === 'paid') return;
    const client = createWsClient();
    const unwatch = client.watchContractEvent({
      address: ROUTER_ADDRESS,
      abi: PAYMENT_ROUTER_ABI,
      eventName: 'InvoicePaid',
      args: { invoiceId: invoice.id as Hex },
      onLogs: (logs) => {
        const hash = logs[0]?.transactionHash;
        if (!hash) return;
        // Hand the hash to the server, which re-verifies it against the chain.
        void fetch(`/api/invoices/${invoice.id}/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ txHash: hash }),
        });
      },
    });
    return () => unwatch();
  }, [invoice.id, status]);

  // Path 2: poll our own API, which is the source of truth.
  useEffect(() => {
    if (status === 'paid') return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/invoices/${invoice.id}`, { cache: 'no-store' });
      const { invoice: fresh } = await res.json();
      if (fresh.status !== status) setStatus(fresh.status);
    }, 400);
    return () => clearInterval(t);
  }, [invoice.id, status]);

  useEffect(() => {
    if (status === 'paid') new Audio('/paid.mp3').play().catch(() => {});
  }, [status]);

  if (status === 'paid') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-emerald-600 text-white">
        <div className="text-9xl">✅</div>
        <h1 className="mt-6 text-5xl font-bold">PAID</h1>
        <p className="mt-2 text-2xl">{invoice.amountDisplay} USDC</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <p className="text-neutral-500">{invoice.description}</p>
        <p className="mt-1 text-7xl font-semibold tabular-nums">
          {invoice.amountDisplay}<span className="ml-3 text-3xl text-neutral-400">USDC</span>
        </p>
      </div>

      <div className="rounded-2xl bg-white p-6 shadow-lg">
        <QRCodeSVG value={payUrl} size={280} />
      </div>

      <p className="text-sm text-neutral-400">
        {status === 'expired' ? 'Expired' : 'Scan with your phone camera to pay'}
      </p>
    </div>
  );
}
```

Create `web/app/pos/[id]/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { PosScreen } from './pos-screen';

export default async function PosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  const host = (await headers()).get('host');
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';

  return <PosScreen invoice={toPublicInvoice(invoice)} payUrl={`${proto}://${host}/pay/${id}`} />;
}
```

- [ ] **Step 3: Add the success sound**

Place any short chime at `web/public/paid.mp3`. The screen degrades silently if the file is missing or autoplay is blocked.

- [ ] **Step 4: Verify both detection paths**

With `pnpm dev` running and an invoice open at `/pos/<id>`:

1. Pay from `/pay/<id>` in another browser → POS flips to PAID.
2. Repeat with a new invoice, but **close the customer tab the instant the wallet confirms** → POS must still flip to PAID (this proves the WebSocket path works independently).

Expected: both flip in under a second.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add POS screen with independent chain-watch and API-poll paths"
```

---

## Task 11: Merchant dashboard (`/dashboard`)

**Files:**
- Create: `web/app/dashboard/page.tsx`
- Create: `web/app/dashboard/dashboard.tsx`
- Create: `web/app/dashboard/sign-in.tsx`

**Interfaces:**
- Consumes: `GET /api/invoices`, `POST /api/invoices` (Task 8); `/api/auth/nonce`, `/api/auth/siwe` (Task 7); `readSession` (Task 7); `txUrl` (Task 1); `formatUsdc` (Task 2).

- [ ] **Step 1: Implement SIWE sign-in**

Create `web/app/dashboard/sign-in.tsx`:

```tsx
'use client';

import { useAccount, useConnect, useSignMessage } from 'wagmi';
import { createSiweMessage } from 'viem/siwe';
import { arcTestnet } from '@/lib/arc';

export function SignIn() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();

  async function signIn() {
    if (!address) return;
    const { nonce } = await (await fetch('/api/auth/nonce')).json();

    const message = createSiweMessage({
      address,
      chainId: arcTestnet.id,
      domain: window.location.host,
      nonce,
      uri: window.location.origin,
      version: '1',
      statement: 'Sign in to ArcPay',
    });

    const signature = await signMessageAsync({ message });

    await fetch('/api/auth/siwe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });

    window.location.reload();
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-semibold">ArcPay</h1>
      <p className="text-neutral-500">Accept USDC at the counter. Settled in under a second.</p>
      {!isConnected ? (
        <button className="rounded-lg bg-black px-6 py-3 text-white" onClick={() => connect({ connector: connectors[0] })}>
          Connect wallet
        </button>
      ) : (
        <button className="rounded-lg bg-black px-6 py-3 text-white" onClick={signIn}>
          Sign in as {address?.slice(0, 6)}…{address?.slice(-4)}
        </button>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Implement the dashboard**

Create `web/app/dashboard/dashboard.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { txUrl } from '@/lib/arc';
import { formatNativeUsdc, formatUsdc } from '@/lib/usdc';
import type { PublicInvoice } from '@/lib/dto';

export function Dashboard({ merchant }: { merchant: string }) {
  const router = useRouter();
  const [invoices, setInvoices] = useState<PublicInvoice[]>([]);
  const [revenue6, setRevenue6] = useState(0n);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  async function load() {
    const res = await fetch('/api/invoices', { cache: 'no-store' });
    const data = await res.json();
    setInvoices(data.invoices);
    setRevenue6(BigInt(data.revenue6));
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function createInvoice(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount, description }),
    });
    if (!res.ok) return;
    const { invoice } = await res.json();
    router.push(`/pos/${invoice.id}`); // straight to the counter screen
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">ArcPay</h1>
        <span className="text-sm text-neutral-500">{merchant.slice(0, 6)}…{merchant.slice(-4)}</span>
      </header>

      <section className="mt-8 rounded-xl border p-6">
        <p className="text-sm text-neutral-500">Revenue collected</p>
        <p className="mt-1 text-4xl font-semibold tabular-nums">{formatUsdc(revenue6)} USDC</p>
      </section>

      <form onSubmit={createInvoice} className="mt-8 flex gap-3">
        <input
          className="w-32 rounded-lg border px-3 py-2"
          placeholder="5.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        <input
          className="flex-1 rounded-lg border px-3 py-2"
          placeholder="Two coffees"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <button className="rounded-lg bg-black px-5 py-2 text-white">Charge</button>
      </form>

      <ul className="mt-8 divide-y">
        {invoices.map((inv) => (
          <li key={inv.id} className="flex items-center justify-between py-3">
            <div>
              <p className="font-medium">{inv.amountDisplay} USDC</p>
              <p className="text-sm text-neutral-500">{inv.description}</p>
            </div>
            <div className="text-right">
              <span
                className={
                  inv.status === 'paid' ? 'text-emerald-600'
                  : inv.status === 'expired' ? 'text-neutral-400'
                  : 'text-amber-600'
                }
              >
                {inv.status}
              </span>
              {inv.txHash && (
                <a className="block text-xs underline" href={txUrl(inv.txHash)} target="_blank" rel="noreferrer">
                  {inv.gasFee ? `gas ${formatNativeUsdc(BigInt(inv.gasFee))} USDC` : 'view tx'}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Create `web/app/dashboard/page.tsx`:

```tsx
import { readSession } from '@/lib/session';
import { Dashboard } from './dashboard';
import { SignIn } from './sign-in';

export default async function DashboardPage() {
  const merchant = await readSession();
  if (!merchant) return <SignIn />;
  return <Dashboard merchant={merchant} />;
}
```

- [ ] **Step 3: Verify the full merchant loop**

With `pnpm dev`: open `/dashboard` → connect → sign in → enter `5` / `Two coffees` → Charge → land on the POS screen with a QR → pay from a phone → PAID appears → return to `/dashboard` and confirm the invoice shows `paid`, the revenue total updated, and the gas fee displays in USDC.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add merchant dashboard with SIWE sign-in and invoice creation"
```

---

## Task 12: Cron reconciliation

The final safety net: money arrived, but both browser tabs were gone.

**Files:**
- Create: `web/app/api/cron/reconcile/route.ts`
- Create: `web/vercel.ts`

**Interfaces:**
- Consumes: `listPending`, `getInvoice` (Task 5); `verifyPayment` (Task 6); `publicClient` (Task 1); `PAYMENT_ROUTER_ABI` / `ROUTER_ADDRESS` (Task 4).

- [ ] **Step 1: Implement the reconciler**

Create `web/app/api/cron/reconcile/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { publicClient } from '@/lib/arc';
import { getInvoice, listPending } from '@/lib/invoices';
import { INVOICE_PAID_EVENT, ROUTER_ADDRESS } from '@/lib/router';
import { verifyPayment } from '@/lib/verify';

const LOOKBACK_BLOCKS = 20_000n; // ~2.5 hours at 0.48s blocks

/**
 * Last line of defence. If the customer paid and every browser tab died before
 * reporting the txHash, the money is still on chain — go and find it.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const pending = await listPending();
  if (pending.length === 0) return NextResponse.json({ checked: 0, settled: 0 });

  const head = await publicClient.getBlockNumber();
  const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;

  let settled = 0;
  for (const invoice of pending) {
    const logs = await publicClient.getLogs({
      address: ROUTER_ADDRESS,
      event: INVOICE_PAID_EVENT,
      args: { invoiceId: invoice.id as Hex },
      fromBlock,
      toBlock: head,
    });

    for (const log of logs) {
      if (!log.transactionHash) continue;
      // Same verifier the /confirm route uses. There is only one.
      const fresh = await getInvoice(invoice.id);
      if (!fresh) break;
      const result = await verifyPayment(fresh, log.transactionHash);
      if (result.ok && !result.alreadyPaid) settled++;
      if (result.ok) break;
    }
  }

  return NextResponse.json({ checked: pending.length, settled });
}
```

- [ ] **Step 2: Schedule it**

Create `web/vercel.ts`:

```ts
import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  framework: 'nextjs',
  crons: [{ path: '/api/cron/reconcile', schedule: '* * * * *' }],
};
```

```bash
cd web && pnpm add -D @vercel/config
vercel env add CRON_SECRET
```

**Plan limitation:** Vercel's Hobby tier caps cron jobs at once per day; the
once-a-minute schedule above needs a Pro project. This does not block the MVP — the
reconciler is a safety net, not a detection path, and the route can always be invoked
by hand (Step 3 does exactly that). If the project stays on Hobby, ship it with the
daily schedule and say so in the README.

- [ ] **Step 3: Verify the safety net actually catches a lost payment**

This is the only way to know the net works — simulate the failure it exists for.

1. Create an invoice.
2. Pay it with a **script**, not the UI, so nothing ever calls `/confirm`:

```bash
cd web && pnpm tsx -e "
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from './lib/arc';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from './lib/router';
import { toNative } from './lib/usdc';

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as \`0x\${string}\`);
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
const amount = toNative(5_000_000n);
const hash = await wallet.writeContract({
  address: ROUTER_ADDRESS,
  abi: PAYMENT_ROUTER_ABI,
  functionName: 'pay',
  args: [process.env.INVOICE_ID as \`0x\${string}\`, process.env.MERCHANT as \`0x\${string}\`, amount],
  value: amount,
});
console.log('paid, tx:', hash);
"
```

3. Confirm the invoice is still `pending` in the dashboard.
4. Trigger the cron by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reconcile
```
Expected: `{"checked":1,"settled":1}`, and the dashboard now shows `paid`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add cron reconciliation for payments no browser reported"
```

---

## Task 13: End-to-end verification on Arc Testnet and demo metrics

Nothing here is a unit test. This task exists to produce the evidence that the MVP succeeds against spec section 11, and the two numbers that go on the hackathon slide.

**Files:**
- Create: `README.md`
- Create: `docs/demo-metrics.md`

- [ ] **Step 1: Run the whole suite**

```bash
cd contracts && forge test
cd ../web && pnpm vitest run && pnpm build
```
Expected: all Foundry tests pass, all Vitest tests pass, the Next build succeeds. **If anything fails, stop and fix it — do not proceed to the demo run.**

- [ ] **Step 2: Deploy to Vercel**

```bash
cd web
vercel env add NEXT_PUBLIC_ROUTER_ADDRESS
vercel env add SESSION_SECRET
vercel --prod
```

- [ ] **Step 3: Run the real demo, on a phone, and record what happens**

Against the production URL, with a real Arc Testnet wallet on a phone:

1. `/dashboard` → sign in with the merchant wallet → charge `5.00` / `Two coffees`.
2. Scan the QR with the **phone camera** (not an in-app scanner).
3. Connect, pay, one signature.
4. Watch the POS screen.

Record, in `docs/demo-metrics.md`:

- Time from tapping Pay to the success screen (the checkout page prints this).
- Time from tapping Pay to the POS screen flipping.
- The exact gas fee, in USDC, from the dashboard row.
- The ArcScan link for the transaction.

- [ ] **Step 4: Check every success criterion from spec section 11**

Write the results into `docs/demo-metrics.md` as a checklist, with evidence for each:

1. POS flips in under one second — measured, not asserted.
2. The customer held only USDC — no second token, no approval, one signature.
3. Every forgery in spec 10.2 is rejected — link to the passing `verify.test.ts` run.
4. The merchant paid zero gas — the merchant wallet's balance is unchanged apart from incoming payments.
5. The UI shows the gas fee in USDC and the time to finality.

**If any criterion fails, it is a bug, not a note. Fix it before claiming the MVP is done.**

- [ ] **Step 5: Write the README**

`README.md` must state, in this order: what ArcPay is in one sentence; the "why Arc, not Base" argument from spec section 1; the measured numbers from Step 3; how to run it locally; the deployed contract address with its ArcScan link.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: add README and measured demo metrics from Arc Testnet"
```

---

## Appendix: Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ARC_RPC_HTTP` | web | Arc RPC (defaults to `https://rpc.testnet.arc.network`) |
| `NEXT_PUBLIC_ARC_RPC_WS` | web | Arc WebSocket for the POS event watch |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | web | Deployed `PaymentRouter` address (Task 4) |
| `DATABASE_URL` | web | Neon Postgres (provisioned in Task 5) |
| `SESSION_SECRET` | web | JWT signing key for SIWE sessions (≥32 bytes) |
| `CRON_SECRET` | web | Bearer token guarding `/api/cron/reconcile` |
| `DEPLOYER_PRIVATE_KEY` | contracts | Deploy key, funded with testnet USDC |
