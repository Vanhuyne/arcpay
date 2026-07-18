'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function TryDemoButton() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'creating' | 'unavailable'>('idle');

  async function start() {
    setState('creating');
    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      if (!res.ok) {
        setState('unavailable');
        return;
      }
      const { posUrl } = await res.json();
      router.push(posUrl);
    } catch {
      setState('unavailable');
    }
  }

  return (
    <div className="hero-cta">
      <div className="hero-cta-row">
        <button className="act hero-act" onClick={start} disabled={state === 'creating'}>
          {state === 'creating' ? 'Printing an invoice…' : 'Try a live payment'}
        </button>
        <Link href="/dashboard" className="hero-secondary">
          Open dashboard
        </Link>
      </div>
      {state === 'unavailable' && (
        <p className="hero-note">The demo till is busy right now — try again in a few minutes.</p>
      )}
    </div>
  );
}
