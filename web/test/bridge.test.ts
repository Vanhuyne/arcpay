import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { createInvoice } from '@/lib/invoices';
import {
  advanceBridgePayment,
  createBridgePayment,
  getBridgePayment,
  listUnfinishedBridgePayments,
  type AdvanceDeps,
} from '@/lib/bridge';

const MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as Address;
const MINT_TX = ('0x' + 'ee'.repeat(32)) as Hex;

function randomHash(): Hex {
  return ('0x' +
    Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      '',
    )) as Hex;
}

async function freshBridgePayment() {
  const invoice = await createInvoice({
    merchant: MERCHANT,
    amount6: 25_000_000n,
    description: 'bridge test',
  });
  const bp = await createBridgePayment({
    burnTxHash: randomHash(),
    invoiceId: invoice.id,
    sourceDomain: 6,
    amount6: invoice.amount6,
    depositor: DEPOSITOR,
  });
  return { invoice, bp };
}

function deps(overrides: Partial<AdvanceDeps> = {}): AdvanceDeps {
  return {
    fetchAttestation: vi.fn().mockResolvedValue({ status: 'pending' }),
    sendMintAndPay: vi.fn().mockResolvedValue(MINT_TX),
    confirmPayment: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('bridge payment lifecycle', () => {
  it('creates a row in burn_confirmed and finds it by invoice', async () => {
    const { invoice, bp } = await freshBridgePayment();
    expect(bp.status).toBe('burn_confirmed');
    const found = await getBridgePayment(invoice.id);
    expect(found?.burnTxHash).toBe(bp.burnTxHash);
  });

  it('stays burn_confirmed while the attestation is pending', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const after = await advanceBridgePayment(bp, invoice, deps());
    expect(after.status).toBe('burn_confirmed');
  });

  it('stores message and attestation when Iris completes', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const after = await advanceBridgePayment(bp, invoice, d);
    expect(after.status).toBe('attested');
    expect(after.message).toBe('0x1234');
    expect(after.attestation).toBe('0x5678');
    // one step per call: mintAndPay must NOT have been sent in the same call
    expect(d.sendMintAndPay).not.toHaveBeenCalled();
  });

  it('relays mintAndPay from attested and lands on paid', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const paid = await advanceBridgePayment(attested, invoice, d);

    expect(d.sendMintAndPay).toHaveBeenCalledWith('0x1234', '0x5678', invoice.id, invoice.merchant);
    expect(d.confirmPayment).toHaveBeenCalled();
    expect(paid.status).toBe('paid');
    expect(paid.mintTxHash).toBe(MINT_TX);
  });

  it('marks failed with already_settled when the router rejects the duplicate', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
      sendMintAndPay: vi.fn().mockRejectedValue(new Error('AlreadySettled')),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const failed = await advanceBridgePayment(attested, invoice, d);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('already_settled');
  });

  it('marks failed with verify_failed when the verifier rejects the mint', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
      confirmPayment: vi.fn().mockResolvedValue(false),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const failed = await advanceBridgePayment(attested, invoice, d);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('verify_failed');
    expect(failed.mintTxHash).toBe(MINT_TX);
  });

  it('leaves the row attested when the relay fails transiently, so it retries', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
      sendMintAndPay: vi.fn().mockRejectedValue(new Error('nonce too low')),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const still = await advanceBridgePayment(attested, invoice, d);
    expect(still.status).toBe('attested');
  });

  it('does not advance terminal rows', async () => {
    const { invoice, bp } = await freshBridgePayment();
    const d = deps({
      fetchAttestation: vi
        .fn()
        .mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' }),
    });
    const attested = await advanceBridgePayment(bp, invoice, d);
    const paid = await advanceBridgePayment(attested, invoice, d);
    const after = await advanceBridgePayment(paid, invoice, d);
    expect(after.status).toBe('paid');
    expect(d.sendMintAndPay).toHaveBeenCalledTimes(1);
  });

  it('lists only unfinished rows', async () => {
    const { bp } = await freshBridgePayment();
    const unfinished = await listUnfinishedBridgePayments();
    expect(unfinished.some((row) => row.burnTxHash === bp.burnTxHash)).toBe(true);
    expect(unfinished.every((row) => row.status === 'burn_confirmed' || row.status === 'attested')).toBe(
      true,
    );
  });
});
