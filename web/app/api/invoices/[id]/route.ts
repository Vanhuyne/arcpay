import { NextResponse } from 'next/server';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';

// Public on purpose: the customer has no account, and an invoice is only
// reachable by knowing its random 32-byte id.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ invoice: toPublicInvoice(invoice) });
}
