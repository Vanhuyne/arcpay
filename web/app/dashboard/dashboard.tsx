'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { txUrl } from '@/lib/arc';
import { formatNativeUsdc, formatUsdc } from '@/lib/usdc';
import type { PublicInvoice } from '@/lib/dto';

export function Dashboard({ merchant }: { merchant: string }) {
  const router = useRouter();
  const [invoices, setInvoices] = useState<PublicInvoice[]>([]);
  const [revenue6, setRevenue6] = useState(0n);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/invoices', { cache: 'no-store' });
    const data = await res.json();
    setInvoices(data.invoices);
    setRevenue6(BigInt(data.revenue6));
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function createInvoice(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount, description }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not create the request.');
      return;
    }
    const { invoice } = await res.json();
    router.push(`/pos/${invoice.id}`); // straight to the counter screen
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.refresh(); // server re-reads the (now absent) session -> SignIn
  }

  return (
    <main>
      <div className="console">
        <header className="console-head">
          <span className="who">
            <span className="dot" aria-hidden />
            {merchant.slice(0, 6)}…{merchant.slice(-4)}
            <button className="signout" onClick={signOut}>
              Sign out
            </button>
          </span>
        </header>

        <section className="panel revenue">
          <p className="label">Revenue collected</p>
          <p className="figure">
            {formatUsdc(revenue6)}<span className="unit">USDC</span>
          </p>
        </section>

        <form onSubmit={createInvoice} className="charge">
          <input
            className="field field--amount"
            placeholder="5.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            aria-label="Amount in USDC"
          />
          <input
            className="field field--desc"
            placeholder="Two coffees"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            aria-label="Description"
          />
          <button className="charge-btn" type="submit">Charge</button>
        </form>
        {error && <p className="charge-error">{error}</p>}

        {invoices.length === 0 ? (
          <p className="ledger-empty">No requests yet. Charge one to open the counter screen.</p>
        ) : (
          <ul className="ledger">
            {invoices.map((inv) => (
              <li key={inv.id} className="row">
                <div>
                  <p className="amt">{inv.amountDisplay} USDC</p>
                  <p className="desc">{inv.description}</p>
                </div>
                <div className="right">
                  <span className={`chip chip--${inv.status}`}>{inv.status}</span>
                  {inv.txHash && (
                    <a className="gas" href={txUrl(inv.txHash)} target="_blank" rel="noreferrer">
                      {inv.gasFee ? `gas ${formatNativeUsdc(BigInt(inv.gasFee))} USDC` : 'view tx'}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
