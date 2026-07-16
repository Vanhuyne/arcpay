import type { Address } from 'viem';
import { invoiceStatus } from '@/lib/invoices';
import { formatUsdc } from '@/lib/usdc';
import type { BridgePayment, Invoice } from '@/db/schema';

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

export type PublicBridge = {
  status: 'burn_confirmed' | 'attested' | 'paid' | 'failed';
  burnTxHash: string;
  mintTxHash: string | null;
  failureReason: string | null;
};

/** The CCTP message and attestation stay server-side: the browser has no use for them. */
export function toPublicBridge(bp: BridgePayment): PublicBridge {
  return {
    status: bp.status,
    burnTxHash: bp.burnTxHash,
    mintTxHash: bp.mintTxHash,
    failureReason: bp.failureReason,
  };
}
