import Link from 'next/link';
import { SiteHeader } from './site-header';

export default function NotFound() {
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      <main className="jam">
        <div className="receipt jam-receipt">
          <p className="eyebrow">ArcPay · lost receipt</p>
          <div className="perf" />
          <h1 className="jam-title">RECEIPT NOT FOUND</h1>
          <p className="jam-text">
            This page never printed. Check the URL, or head back to the counter.
          </p>
          <Link href="/" className="jam-link">
            Back to the homepage
          </Link>
        </div>
      </main>
    </div>
  );
}
