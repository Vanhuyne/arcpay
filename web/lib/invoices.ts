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
