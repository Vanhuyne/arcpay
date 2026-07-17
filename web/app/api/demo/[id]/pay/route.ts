import { NextResponse } from 'next/server';
import type { Address, Hex } from 'viem';
import { canAutoPay } from '@/lib/demo';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { relayerAddress, sendRouterPay } from '@/lib/relayer';
import { verifyPayment } from '@/lib/verify';

/**
 * The ops wallet pays a demo invoice. Guarded: only pending invoices whose
 * merchant IS the ops wallet — this endpoint cannot be pointed at real
 * invoices, and a double call dies in simulation (router reverts a re-pay).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const gate = canAutoPay(invoice, relayerAddress());
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 409 });

  let hash: Hex;
  try {
    hash = await sendRouterPay(invoice.id as Hex, invoice.merchant as Address, invoice.amount6);
  } catch {
    return NextResponse.json({ error: 'payment failed' }, { status: 502 });
  }

  // Same single verifier as every other settlement path (invariant #2).
  const result = await verifyPayment(invoice, hash);
  if (!result.ok) {
    return NextResponse.json({ error: 'verification failed', reason: result.reason }, { status: 502 });
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({ invoice: toPublicInvoice(fresh!) });
}
