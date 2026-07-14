import { notFound } from 'next/navigation';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { Checkout } from './checkout';

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  return (
    <main className="terminal-bg flex min-h-dvh items-center justify-center p-6">
      <Checkout invoice={toPublicInvoice(invoice)} />
    </main>
  );
}
