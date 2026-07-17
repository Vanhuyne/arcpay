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
