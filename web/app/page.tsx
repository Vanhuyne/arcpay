import type { Metadata } from 'next';
import { addressUrl } from '@/lib/arc';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { ROUTER_ADDRESS } from '@/lib/router';
import { HeroReceipt } from './hero-receipt';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { TryDemoButton } from './try-demo-button';

export const metadata: Metadata = {
  title: 'ArcPay — point-of-sale USDC payments on Arc',
  description:
    'Turn any phone into a USDC till. One signature from the customer, zero gas for the merchant, settled on Arc in under a second.',
};

export default function Home() {
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      <main className="site-main">
        <section className="hero">
          <div>
            <h1>
              Point-of-sale USDC payments.
              <br />
              Settled before the receipt prints.
            </h1>
            <p className="hero-sub">
              ArcPay turns any phone into a USDC till on Arc. The customer signs once, the
              merchant never touches gas, and the counter flips to PAID in under a second.
            </p>
            <TryDemoButton />
          </div>
          <HeroReceipt />
        </section>

        <section className="stats">
          <div className="stat">
            <p className="stat-figure">0.77&thinsp;s</p>
            <p className="stat-label">median on-chain settlement, measured on Arc Testnet</p>
          </div>
          <div className="stat">
            <p className="stat-figure">0 gas</p>
            <p className="stat-label">for merchants — creating an invoice is not a transaction</p>
          </div>
          <div className="stat">
            <p className="stat-figure">no reorgs</p>
            <p className="stat-label">deterministic finality: paid means paid, at the counter</p>
          </div>
        </section>
        <p className="stats-honesty">
          0.77&thinsp;s is chain settlement — submission to PAID. The wall clock a customer sees
          also includes confirming in their wallet; that part is human, not Arc.
        </p>

        <section id="how-it-works" className="how">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <h3>Charge</h3>
              <p>
                The merchant types an amount and taps Charge. ArcPay prints a QR invoice — a
                database row, not a transaction. No wallet, no gas.
              </p>
            </li>
            <li>
              <h3>Scan &amp; sign</h3>
              <p>
                The customer scans, sees the invoice, and signs once. On Arc, gas is USDC too —
                they hold nothing else.
              </p>
            </li>
            <li>
              <h3>Settled</h3>
              <p>
                The router emits InvoicePaid, the server re-verifies it on-chain, and the counter
                flips to PAID — in under a second.
              </p>
            </li>
          </ol>
          <div className="how-bridge">
            <h3>Paying from Base Sepolia?</h3>
            <p>
              ArcPay accepts CCTP v2: burn USDC on Base Sepolia, Circle attests the transfer
              (typically 10–20 minutes for a standard transfer), and the ops wallet mints and pays
              the invoice on Arc. The counter still flips the moment it settles.
            </p>
          </div>
        </section>

        <section className="open">
          <h2>Built in the open</h2>
          <p>
            Every payment settles through two audited-by-you contracts on Arc Testnet.
          </p>
          <ul className="open-list">
            <li>
              <span>PaymentRouter</span>
              <a href={addressUrl(ROUTER_ADDRESS)} target="_blank" rel="noreferrer">
                {ROUTER_ADDRESS}
              </a>
            </li>
            <li>
              <span>CrossPayForwarder</span>
              <a href={addressUrl(FORWARDER_ADDRESS)} target="_blank" rel="noreferrer">
                {FORWARDER_ADDRESS}
              </a>
            </li>
            <li>
              <span>Source</span>
              <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
                github.com/Vanhuyne/arcpay
              </a>
            </li>
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
