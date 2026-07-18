'use client';

// No SiteHeader here: the boundary must not depend on server components
// that could themselves be the failure.
export default function Error({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="terminal-bg site">
      <main className="jam">
        <div className="receipt jam-receipt">
          <p className="eyebrow">ArcPay · malfunction</p>
          <div className="perf" />
          <h1 className="jam-title">SOMETHING JAMMED THE PRINTER</h1>
          <p className="jam-text">An unexpected error stopped this page. It was not your fault.</p>
          <button className="act jam-act" onClick={() => unstable_retry()}>
            Try again
          </button>
        </div>
      </main>
    </div>
  );
}
