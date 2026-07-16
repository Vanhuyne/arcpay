import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import {
  advanceBridgePayment,
  createBridgePayment,
  getBridgePayment,
} from '@/lib/bridge';
import { SOURCE_CHAINS, verifyBurn } from '@/lib/cctp';
import { toPublicBridge, toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';

/**
 * The browser reports a burn it claims to have made on the source chain.
 * Nothing is believed: verifyBurn re-reads the receipt from that chain and
 * requires forwarder recipient + Arc domain + exact invoice amount.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { burnTxHash, sourceDomain } = await req.json();

  if (typeof burnTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
    return NextResponse.json({ error: 'invalid burnTxHash' }, { status: 400 });
  }
  if (typeof sourceDomain !== 'number' || !SOURCE_CHAINS[sourceDomain]) {
    return NextResponse.json({ error: 'unsupported source domain' }, { status: 400 });
  }

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Idempotent: re-posting the same burn returns the existing row.
  const existing = await getBridgePayment(id);
  if (existing) {
    return NextResponse.json({
      bridge: toPublicBridge(existing),
      invoice: toPublicInvoice(invoice),
    });
  }

  const result = await verifyBurn(invoice, sourceDomain, burnTxHash as Hex);
  if (!result.ok) {
    return NextResponse.json({ error: 'burn verification failed', reason: result.reason }, {
      status: 400,
    });
  }

  const bridge = await createBridgePayment({
    burnTxHash: burnTxHash as Hex,
    invoiceId: id,
    sourceDomain,
    amount6: invoice.amount6,
    depositor: result.depositor,
  });

  return NextResponse.json(
    { bridge: toPublicBridge(bridge), invoice: toPublicInvoice(invoice) },
    { status: 201 },
  );
}

/** Poll target: each call advances the state machine one non-blocking step. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let bridge = await getBridgePayment(id);
  if (!bridge) return NextResponse.json({ error: 'no bridge payment' }, { status: 404 });

  if (bridge.status === 'burn_confirmed' || bridge.status === 'attested') {
    bridge = await advanceBridgePayment(bridge, invoice);
  }

  const fresh = await getInvoice(id);
  return NextResponse.json({
    bridge: toPublicBridge(bridge),
    invoice: toPublicInvoice(fresh!),
  });
}
