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

  it('keeps the 18-decimal gas fee as a string too', () => {
    // 0.00115 USDC of gas. As a JS number this is fine, but as an 18-decimal bigint
    // it is not — and the DTO must not be the place where that distinction is lost.
    const paid: Invoice = { ...inv, status: 'paid', gasFee: 1_151_682_800_000_000n };
    const dto = toPublicInvoice(paid, new Date('2026-07-13T10:05:00Z'));
    expect(dto.gasFee).toBe('1151682800000000');
    expect(typeof dto.gasFee).toBe('string');
  });
});
