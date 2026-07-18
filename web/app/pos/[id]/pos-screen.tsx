'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Hex } from 'viem';
import { createWsClient } from '@/lib/arc';
import { playPaidChime } from '@/lib/chime';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import type { PublicInvoice } from '@/lib/dto';

export function PosScreen({
  invoice,
  payUrl,
  demo = false,
}: {
  invoice: PublicInvoice;
  payUrl: string;
  demo?: boolean;
}) {
  const [status, setStatus] = useState(invoice.status);

  // Path 1: watch the chain directly. Independent of the customer's browser —
  // if they pay and immediately close the tab, we still see it.
  useEffect(() => {
    if (status === 'paid') return;
    const client = createWsClient();
    const unwatch = client.watchContractEvent({
      address: ROUTER_ADDRESS,
      abi: PAYMENT_ROUTER_ABI,
      eventName: 'InvoicePaid',
      args: { invoiceId: invoice.id as Hex },
      onLogs: (logs) => {
        const hash = logs[0]?.transactionHash;
        if (!hash) return;
        // Hand the hash to the server, which re-verifies it against the chain.
        void fetch(`/api/invoices/${invoice.id}/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ txHash: hash }),
        });
      },
    });
    return () => unwatch();
  }, [invoice.id, status]);

  // Path 2: poll our own API, which is the source of truth.
  useEffect(() => {
    if (status === 'paid') return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/invoices/${invoice.id}`, { cache: 'no-store' });
      const { invoice: fresh } = await res.json();
      if (fresh.status !== status) setStatus(fresh.status);
    }, 400);
    return () => clearInterval(t);
  }, [invoice.id, status]);

  useEffect(() => {
    if (status === 'paid') playPaidChime();
  }, [status]);

  // Demo mode: after a beat, ask the server to pay this invoice from the ops
  // wallet. The endpoint re-checks merchant + status server-side; this call is
  // just a trigger, not trusted.
  useEffect(() => {
    if (!demo || status !== 'pending') return;
    const t = setTimeout(() => {
      void fetch(`/api/demo/${invoice.id}/pay`, { method: 'POST' });
    }, 4500);
    return () => clearTimeout(t);
  }, [demo, invoice.id, status]);

  if (status === 'paid') {
    return (
      <div className="pos-paid" role="status" aria-live="assertive">
        <div className="stamp-lg" aria-hidden>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
        </div>
        <h1>PAID</h1>
        <p className="pos-paid-amount">{invoice.amountDisplay} USDC · {invoice.description}</p>
        {demo ? (
          <p className="pos-note">
            That was a real transaction on Arc Testnet.{' '}
            <a href="/">Back to the homepage</a>
          </p>
        ) : (
          <p className="pos-note">
            <a href="/dashboard">Charge the next customer</a>
          </p>
        )}
      </div>
    );
  }

  const expired = status === 'expired';

  return (
    <main className="terminal-bg pos">
      <div>
        <p className="pos-eyebrow">ArcPay · point of sale</p>
        <p className="pos-desc">{invoice.description}</p>
        <p className="pos-amount">
          {invoice.amountDisplay}<span className="unit">USDC</span>
        </p>
      </div>

      {demo && !expired && (
        <p className="demo-banner">
          <span className="beacon" aria-hidden />
          Live demo — the ops wallet pays this invoice in a few seconds
        </p>
      )}

      <div className="qr-tile">
        <QRCodeSVG value={payUrl} size={272} fgColor="#0b1020" bgColor="#fbfaf7" level="M" />
      </div>

      {expired ? (
        <p className="pos-wait" style={{ color: 'var(--alert)' }}>
          This request has expired — create a new one.
        </p>
      ) : (
        <p className="pos-wait">
          <span className="beacon" aria-hidden />
          Scan with your phone camera to pay
        </p>
      )}
    </main>
  );
}
