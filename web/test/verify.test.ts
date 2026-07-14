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

/**
 * Arc's native-USDC system precompile. Every real payment receipt carries ERC-20
 * Transfer logs from this address alongside the router's InvoicePaid — verified live
 * against tx 0x002462ab...c041e on Arc Testnet.
 */
const SYSTEM_PRECOMPILE = '0xfffffffffffffffffffffffffffffffffffffffe';

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
  const data =
    `0x${amount.toString(16).padStart(64, '0')}${(1752400000n).toString(16).padStart(64, '0')}` as Hex;
  return { address: opts.address ?? ROUTER_ADDRESS, topics, data };
}

/** An ERC-20 Transfer log from the system precompile — noise the verifier must skip. */
function systemTransferLog() {
  return {
    address: SYSTEM_PRECOMPILE,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'0'.repeat(24)}${PAYER.slice(2)}`,
      `0x${'0'.repeat(24)}${MERCHANT.slice(2)}`,
    ] as [Hex, Hex, Hex],
    data: `0x${(5_000_000_000_000_000_000n).toString(16).padStart(64, '0')}` as Hex,
  };
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

  it('accepts a real Arc receipt, where the router log is not the first log', async () => {
    // On Arc every payment receipt also carries Transfer logs from the native-USDC
    // precompile. A verifier that decoded logs[0] would reject every genuine payment.
    const receipt = {
      ...goodReceipt,
      logs: [systemTransferLog(), systemTransferLog(), invoicePaidLog({})],
    };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: true, alreadyPaid: false });
  });

  it('rejects a fabricated txHash with no receipt', async () => {
    const client = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not found')) };
    const res = await verifyPayment(invoice, TX, client as unknown as PublicClient);
    expect(res).toEqual({ ok: false, reason: 'no_receipt' });
  });

  it('rejects a reverted transaction', async () => {
    const res = await verifyPayment(
      invoice,
      TX,
      clientReturning({ ...goodReceipt, status: 'reverted' }),
    );
    expect(res).toEqual({ ok: false, reason: 'tx_reverted' });
  });

  it('rejects a log emitted by a contract other than the router', async () => {
    const receipt = { ...goodReceipt, logs: [invoicePaidLog({ address: OTHER })] };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'no_router_log' });
  });

  it('rejects a receipt that pays a different invoice', async () => {
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
    const receipt = {
      ...goodReceipt,
      logs: [invoicePaidLog({ amountNative: 4_999_999_999_999_999_999n })],
    };
    const res = await verifyPayment(invoice, TX, clientReturning(receipt));
    expect(res).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('is idempotent: an already-paid invoice verifies without rewriting', async () => {
    const paid: Invoice = { ...invoice, status: 'paid', txHash: TX };
    const res = await verifyPayment(paid, TX, clientReturning(goodReceipt));
    expect(res).toEqual({ ok: true, alreadyPaid: true });
  });
});
