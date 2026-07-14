import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { publicClient } from '@/lib/arc';
import { getInvoice, listPending } from '@/lib/invoices';
import { INVOICE_PAID_EVENT, ROUTER_ADDRESS } from '@/lib/router';
import { verifyPayment } from '@/lib/verify';

const LOOKBACK_BLOCKS = 20_000n; // ~2.5 hours at 0.48s blocks
// Arc's RPC rejects any eth_getLogs spanning more than 10,000 blocks (-32614), so the
// lookback is walked in sub-windows under that cap rather than one call.
const MAX_LOG_RANGE = 9_000n;

/** Every InvoicePaid log for one invoice across [fromBlock, toBlock], paged under the RPC cap. */
async function getPaidLogs(invoiceId: Hex, fromBlock: bigint, toBlock: bigint) {
  const all = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE + 1n) {
    const end = start + MAX_LOG_RANGE > toBlock ? toBlock : start + MAX_LOG_RANGE;
    const logs = await publicClient.getLogs({
      address: ROUTER_ADDRESS,
      event: INVOICE_PAID_EVENT,
      args: { invoiceId },
      fromBlock: start,
      toBlock: end,
    });
    all.push(...logs);
  }
  return all;
}

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
    const logs = await getPaidLogs(invoice.id as Hex, fromBlock, head);

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
