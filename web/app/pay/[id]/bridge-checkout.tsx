'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { pad, type Hex } from 'viem';
import {
  ARC_DOMAIN,
  baseSepolia,
  ERC20_ABI,
  SOURCE_CHAINS,
  STANDARD_FINALITY,
  TOKEN_MESSENGER,
  TOKEN_MESSENGER_ABI,
} from '@/lib/cctp';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { wagmiConfig } from '@/lib/wagmi';
import type { PublicBridge, PublicInvoice } from '@/lib/dto';

type Phase = 'idle' | 'approving' | 'burning' | 'bridging' | 'failed' | 'error';

const POLL_MS = 3000;
const BASE = SOURCE_CHAINS[6];

const STEP_LABELS = [
  'Approve USDC on Base',
  'Burn on Base Sepolia',
  'Circle attestation (~1 min)',
  'Minted & paid on Arc',
];

/** Index of the step currently in progress; everything before it is done. */
function activeStep(phase: Phase): number {
  return phase === 'approving' ? 0 : phase === 'burning' ? 1 : 2;
}

export function BridgeCheckout({ invoice }: { invoice: PublicInvoice }) {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>('idle');
  const [bridge, setBridge] = useState<PublicBridge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the server while it relays attestation -> mint -> pay.
  useEffect(() => {
    if (phase !== 'bridging') return;
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/invoices/${invoice.id}/bridge`);
      if (!res.ok) return; // transient — next tick retries
      const data = await res.json();
      setBridge(data.bridge);
      // Paid: reload so the page shows the standard receipt view (the mint tx
      // is now the invoice's txHash — same InvoicePaid path as a direct payment).
      if (data.bridge.status === 'paid') location.reload();
      if (data.bridge.status === 'failed') setPhase('failed');
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, invoice.id]);

  async function payFromBase() {
    setError(null);
    try {
      if (chainId !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }

      const amount6 = BigInt(invoice.amount6); // 6-decimal, same unit the burn uses

      setPhase('approving');
      const approveHash = await writeContractAsync({
        chainId: baseSepolia.id,
        address: BASE.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TOKEN_MESSENGER, amount6],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: baseSepolia.id });

      setPhase('burning');
      const forwarder32 = pad(FORWARDER_ADDRESS, { size: 32 });
      const burnHash = await writeContractAsync({
        chainId: baseSepolia.id,
        address: TOKEN_MESSENGER,
        abi: TOKEN_MESSENGER_ABI,
        functionName: 'depositForBurn',
        args: [amount6, ARC_DOMAIN, forwarder32, BASE.usdc, forwarder32, 0n, STANDARD_FINALITY],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: burnHash, chainId: baseSepolia.id });

      // Report the burn — the server re-verifies it before trusting anything.
      const res = await fetch(`/api/invoices/${invoice.id}/bridge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ burnTxHash: burnHash, sourceDomain: BASE.domain }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.reason ?? body.error ?? 'burn rejected');
      }
      setBridge((await res.json()).bridge);
      setPhase('bridging');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'idle' || phase === 'error') {
    return (
      <>
        <button className="act" disabled={invoice.status === 'expired'} onClick={payFromBase}>
          Pay {invoice.amountDisplay} USDC from Base Sepolia
        </button>
        <p className="note">
          Two signatures on Base — the rest settles on Arc automatically.
        </p>
        {error && <p className="banner banner--danger">{error}</p>}
      </>
    );
  }

  const current = activeStep(phase);

  return (
    <div aria-live="polite">
      <ol className="bridge-steps">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className={i < current ? 'done' : i === current ? 'active' : ''}>
            {label}
          </li>
        ))}
      </ol>

      {phase === 'bridging' && (
        <p className="note">
          Bridging via CCTP. You can close this page — the payment completes on its own.
        </p>
      )}

      {phase === 'failed' && (
        <p className="banner banner--danger">
          Bridge payment failed ({bridge?.failureReason ?? 'unknown'}). Your USDC will be
          refunded to your address on Arc — contact the merchant.
        </p>
      )}
    </div>
  );
}
