import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { verifyPayment } from '@/lib/verify';

/**
 * The browser tells us a txHash. We believe none of it — verifyPayment goes
 * back to the chain and checks the emitted event against our own record.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { txHash } = await req.json();

  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: 'invalid txHash' }, { status: 400 });
  }

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const result = await verifyPayment(invoice, txHash as Hex);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'verification failed', reason: result.reason },
      { status: 400 },
    );
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({ invoice: toPublicInvoice(fresh!) });
}
