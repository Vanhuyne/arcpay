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
