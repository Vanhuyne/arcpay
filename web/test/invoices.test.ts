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
