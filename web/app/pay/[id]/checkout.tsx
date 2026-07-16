'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import type { Hex } from 'viem';
import { arcTestnet, txUrl } from '@/lib/arc';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { toNative } from '@/lib/usdc';
import { wagmiConfig } from '@/lib/wagmi';
import type { PublicInvoice } from '@/lib/dto';
import { BridgeCheckout } from './bridge-checkout';

type Phase = 'idle' | 'signing' | 'confirming' | 'paid' | 'error';

const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Checkout({ invoice }: { invoice: PublicInvoice }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>(invoice.status === 'paid' ? 'paid' : 'idle');
  const [txHash, setTxHash] = useState<Hex | null>(invoice.txHash as Hex | null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [liveMs, setLiveMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'arc' | 'base'>('arc');

  const wrongChain = isConnected && chainId !== arcTestnet.id;
  const working = phase === 'signing' || phase === 'confirming';

  // Guarded on source so the auto-switch never yanks the wallet back to Arc mid-bridge.
  useEffect(() => {
    if (source === 'arc' && wrongChain) switchChain({ chainId: arcTestnet.id });
  }, [source, wrongChain, switchChain]);

  // The live stopwatch: the product's whole claim is that this number stays small.
  // The finality clock times settlement only: it starts when the signed tx is
  // submitted, not when the customer taps Pay. The seconds spent deciding in the
  // wallet are the customer's, not Arc's, and must not inflate "time to final".
  const settling = phase === 'confirming';
  const startRef = useRef(0);
  useEffect(() => {
    if (!settling) return;
    let raf = 0;
    const loop = () => {
      setLiveMs(performance.now() - startRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [settling]);

  async function pay() {
    setError(null);
    setLiveMs(0);
    setPhase('signing');

    try {
      const amountNative = toNative(BigInt(invoice.amount6));

      const hash = await writeContractAsync({
        address: ROUTER_ADDRESS,
        abi: PAYMENT_ROUTER_ABI,
        functionName: 'pay',
        args: [invoice.id as Hex, invoice.merchant, amountNative],
        value: amountNative, // gas is USDC too — the customer holds nothing else
      });

      // Tx is now on the wire — start the settlement clock here.
      startRef.current = performance.now();
      setTxHash(hash);
      setPhase('confirming');

      await waitForTransactionReceipt(wagmiConfig, { hash });
      setElapsedMs(Math.round(performance.now() - startRef.current));

      // A hint to the server; it will re-verify against the chain itself.
      await fetch(`/api/invoices/${invoice.id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: hash }),
      });

      setPhase('paid');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'paid') {
    const seconds = elapsedMs !== null ? (elapsedMs / 1000).toFixed(2) : null;
    return (
      <div className="receipt" role="status" aria-live="polite">
        <div className="stamp" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
        </div>
        <p className="eyebrow paid-eyebrow" style={{ textAlign: 'center', marginTop: '1rem' }}>
          Payment settled
        </p>

        {seconds ? (
          <p className="stopwatch paid-time" style={{ textAlign: 'center', marginTop: '0.5rem' }}>
            {seconds}<span className="s">s to final</span>
          </p>
        ) : (
          <p className="amount" style={{ textAlign: 'center', marginTop: '0.8rem' }}>
            {invoice.amountDisplay}<span className="unit">USDC</span>
          </p>
        )}

        <hr className="perf" />

        <div className="receipt-meta">
          <span>Amount</span>
          <span>{invoice.amountDisplay} USDC</span>
        </div>
        <div className="receipt-meta">
          <span>For</span>
          <span>{invoice.description}</span>
        </div>
        <div className="receipt-meta">
          <span>To</span>
          <span>{shortAddr(invoice.merchant)}</span>
        </div>
        {txHash && (
          <div className="receipt-meta">
            <span>Tx</span>
            <span>
              <a href={txUrl(txHash)} target="_blank" rel="noreferrer">{shortHash(txHash)}</a>
            </span>
          </div>
        )}
      </div>
    );
  }

  const expired = invoice.status === 'expired';

  return (
    <div className="receipt">
      <p className="eyebrow">ArcPay · request to pay</p>
      <p style={{ marginTop: '0.7rem', color: 'var(--label)', fontSize: '0.92rem' }}>
        {invoice.description}
      </p>

      <p className="amount" style={{ marginTop: '0.6rem' }}>
        {invoice.amountDisplay}<span className="unit">USDC</span>
      </p>

      <hr className="perf" />

      <div className="receipt-meta">
        <span>To merchant</span>
        <span>{shortAddr(invoice.merchant)}</span>
      </div>

      {expired && (
        <p className="banner banner--alert">
          This request has expired. Ask the merchant for a new one.
        </p>
      )}

      <div className="source-toggle" role="tablist" aria-label="Pay from">
        <button
          role="tab"
          aria-selected={source === 'arc'}
          className={source === 'arc' ? 'on' : ''}
          onClick={() => setSource('arc')}
        >
          Arc
        </button>
        <button
          role="tab"
          aria-selected={source === 'base'}
          className={source === 'base' ? 'on' : ''}
          onClick={() => setSource('base')}
        >
          Base Sepolia
        </button>
      </div>

      {source === 'base' ? (
        !isConnected ? (
          <button className="act" onClick={() => connect({ connector: connectors[0] })}>
            Connect wallet
          </button>
        ) : (
          <BridgeCheckout invoice={invoice} />
        )
      ) : !isConnected ? (
        <button className="act" onClick={() => connect({ connector: connectors[0] })}>
          Connect wallet
        </button>
      ) : working ? (
        <div className="act act--working" aria-live="polite">
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="tick" aria-hidden />
            {phase === 'signing' ? 'Confirm in your wallet' : 'Settling on Arc'}
          </span>
          {/* No clock while the wallet is open — nothing is settling yet. */}
          <span className="stopwatch">{settling ? `${(liveMs / 1000).toFixed(2)}s` : ''}</span>
        </div>
      ) : (
        <button className="act" disabled={expired} onClick={pay}>
          Pay {invoice.amountDisplay} USDC
        </button>
      )}

      {isConnected && !working && (
        <p className="wallet-line">
          {address ? `${shortAddr(address)}` : ''}
          <button className="disconnect" onClick={() => disconnect()}>
            Disconnect
          </button>
        </p>
      )}

      <p className="note">
        Gas is paid in USDC — no other token required.
        <br />
        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Need testnet USDC?</a>
      </p>

      {error && <p className="banner banner--danger">{error}</p>}
    </div>
  );
}
