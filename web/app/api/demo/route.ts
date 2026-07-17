import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '@/db';
import { invoices } from '@/db/schema';
import { publicClient } from '@/lib/arc';
import { DEMO_AMOUNT6, DEMO_DESCRIPTION, DEMO_WINDOW_MS, demoAllowed } from '@/lib/demo';
import { createInvoice } from '@/lib/invoices';
import { relayerAddress } from '@/lib/relayer';

/**
 * Start a homepage demo: create a real invoice whose merchant is the ops
 * wallet. Unauthenticated by design — the gates below are the protection.
 */
export async function POST(req: Request) {
  const merchant = relayerAddress();

  // Serverless-safe rate cap: count recent demo invoices in the DB instead of
  // keeping in-memory state that each lambda would lose.
  const since = new Date(Date.now() - DEMO_WINDOW_MS);
  const recent = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.merchant, merchant.toLowerCase()), gte(invoices.createdAt, since)));
  const balance = await publicClient.getBalance({ address: merchant });

  const gate = demoAllowed({ recentCount: recent.length, relayerBalance18: balance });
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.reason },
      { status: gate.reason === 'rate_limited' ? 429 : 503 },
    );
  }

  const invoice = await createInvoice({
    merchant,
    amount6: DEMO_AMOUNT6,
    description: DEMO_DESCRIPTION,
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    invoiceId: invoice.id,
    posUrl: `${origin}/pos/${invoice.id}?demo=1`,
  });
}
