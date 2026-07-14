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

export type VerifyResult = { ok: true; alreadyPaid: boolean } | { ok: false; reason: VerifyFailure };

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

  // A genuine Arc receipt also carries ERC-20 Transfer logs from the native-USDC
  // precompile, and the router's log is not necessarily first. Filtering by emitter
  // is what makes this correct — and it is also what stops a look-alike InvoicePaid
  // emitted by an attacker's own contract from being believed.
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
