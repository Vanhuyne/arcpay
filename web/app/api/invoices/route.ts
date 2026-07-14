import { NextResponse } from 'next/server';
import { toPublicInvoice } from '@/lib/dto';
import { createInvoice, listInvoices } from '@/lib/invoices';
import { readSession } from '@/lib/session';
import { parseUsdc } from '@/lib/usdc';

export async function POST(req: Request) {
  const merchant = await readSession();
  if (!merchant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { amount, description } = await req.json();

  let amount6: bigint;
  try {
    amount6 = parseUsdc(String(amount));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const invoice = await createInvoice({
    merchant,
    amount6,
    description: String(description ?? '').slice(0, 200),
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    invoice: toPublicInvoice(invoice),
    payUrl: `${origin}/pay/${invoice.id}`,
  });
}

export async function GET() {
  const merchant = await readSession();
  if (!merchant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await listInvoices(merchant);
  const now = new Date();
  const paid = rows.filter((r) => r.status === 'paid');
  const revenue6 = paid.reduce((sum, r) => sum + r.amount6, 0n);

  return NextResponse.json({
    invoices: rows.map((r) => toPublicInvoice(r, now)),
    revenue6: revenue6.toString(),
  });
}
