import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { toPublicInvoice } from '@/lib/dto';
import { getInvoice } from '@/lib/invoices';
import { PosScreen } from './pos-screen';

export default async function PosPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ demo?: string }>;
}) {
  const { id } = await params;
  const { demo } = await searchParams;
  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  const host = (await headers()).get('host');
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';

  return (
    <PosScreen
      invoice={toPublicInvoice(invoice)}
      payUrl={`${proto}://${host}/pay/${id}`}
      demo={demo === '1'}
    />
  );
}
