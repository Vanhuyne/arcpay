'use client';

import { useState } from 'react';
import { useAccount, useConnect, useSignMessage } from 'wagmi';
import { createSiweMessage } from 'viem/siwe';
import { arcTestnet } from '@/lib/arc';

export function SignIn() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (!address) return;
    setBusy(true);
    try {
      const { nonce } = await (await fetch('/api/auth/nonce')).json();

      const message = createSiweMessage({
        address,
        chainId: arcTestnet.id,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to ArcPay',
      });

      const signature = await signMessageAsync({ message });

      await fetch('/api/auth/siwe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });

      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <p className="tagline">Accept USDC at the counter. Settled in under a second.</p>
      {!isConnected ? (
        <button className="cta" onClick={() => connect({ connector: connectors[0] })}>
          Connect wallet
        </button>
      ) : (
        <button className="cta" onClick={signIn} disabled={busy}>
          {busy ? 'Check your wallet…' : `Sign in as ${address?.slice(0, 6)}…${address?.slice(-4)}`}
        </button>
      )}
    </main>
  );
}
