import Link from 'next/link';
import { readSession } from '@/lib/session';

/** Site chrome for landing + merchant pages. POS/checkout screens never render this. */
export async function SiteHeader() {
  const merchant = await readSession();
  return (
    <header className="site-header">
      <Link href="/" className="wordmark site-wordmark">
        ArcPay
      </Link>
      <nav className="site-nav">
        <Link href="/#how-it-works">How it works</Link>
        <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <Link href="/dashboard" className="site-nav-cta">
          {merchant ? 'Dashboard' : 'Sign in'}
        </Link>
      </nav>
    </header>
  );
}
