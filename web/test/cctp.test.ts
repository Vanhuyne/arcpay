import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, type Hex, type PublicClient } from 'viem';
import {
  ARC_DOMAIN,
  fetchAttestation,
  SOURCE_CHAINS,
  TOKEN_MESSENGER,
  TOKEN_MESSENGER_ABI,
  verifyBurn,
} from '@/lib/cctp';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import type { Invoice } from '@/db/schema';

const BASE_DOMAIN = 6;
const BURN_TX = ('0x' + 'ab'.repeat(32)) as Hex;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as const;

const invoice: Invoice = {
  id: '0x' + 'cd'.repeat(32),
  merchant: '0x2222222222222222222222222222222222222222',
  amount6: 25_000_000n, // 25 USDC
  description: 'test',
  status: 'pending',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 900_000),
  txHash: null,
  payer: null,
  blockNumber: null,
  paidAt: null,
  gasFee: null,
  wasLate: false,
};

/** A synthetic Base Sepolia receipt carrying one DepositForBurn log. */
function receiptWithBurn(
  overrides: Partial<
    Record<'amount' | 'mintRecipient' | 'destinationDomain' | 'destinationCaller' | 'burnToken', unknown>
  > = {},
) {
  // Indexed fields go in topics…
  const topics = encodeEventTopics({
    abi: TOKEN_MESSENGER_ABI,
    eventName: 'DepositForBurn',
    args: {
      burnToken: (overrides.burnToken ?? SOURCE_CHAINS[BASE_DOMAIN].usdc) as `0x${string}`,
      depositor: DEPOSITOR,
      minFinalityThreshold: 2000,
    },
  });
  // …non-indexed fields go in data, in event-declaration order.
  const data = encodeAbiParameters(
    [
      { type: 'uint256' }, // amount
      { type: 'bytes32' }, // mintRecipient
      { type: 'uint32' }, // destinationDomain
      { type: 'bytes32' }, // destinationTokenMessenger
      { type: 'bytes32' }, // destinationCaller
      { type: 'uint256' }, // maxFee
      { type: 'bytes' }, // hookData
    ],
    [
      (overrides.amount ?? invoice.amount6) as bigint,
      (overrides.mintRecipient ?? pad(FORWARDER_ADDRESS, { size: 32 })) as Hex,
      (overrides.destinationDomain ?? ARC_DOMAIN) as number,
      pad(TOKEN_MESSENGER, { size: 32 }),
      (overrides.destinationCaller ?? pad(FORWARDER_ADDRESS, { size: 32 })) as Hex,
      0n,
      '0x',
    ],
  );
  return {
    status: 'success' as const,
    logs: [{ address: TOKEN_MESSENGER, topics, data }],
  };
}

function mockClient(receipt: unknown): PublicClient {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  } as unknown as PublicClient;
}

describe('verifyBurn', () => {
  it('accepts a burn matching invoice amount, forwarder recipient, and Arc domain', async () => {
    const result = await verifyBurn(invoice, BASE_DOMAIN, BURN_TX, mockClient(receiptWithBurn()));
    expect(result).toEqual({ ok: true, depositor: DEPOSITOR.toLowerCase() });
  });

  it('rejects an unknown source domain', async () => {
    const result = await verifyBurn(invoice, 999, BURN_TX, mockClient(receiptWithBurn()));
    expect(result).toEqual({ ok: false, reason: 'unknown_domain' });
  });

  it('rejects a reverted burn tx', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient({ status: 'reverted', logs: [] }),
    );
    expect(result).toEqual({ ok: false, reason: 'tx_reverted' });
  });

  it('rejects a receipt with no DepositForBurn from the TokenMessenger', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient({ status: 'success', logs: [] }),
    );
    expect(result).toEqual({ ok: false, reason: 'no_burn_log' });
  });

  it('rejects a burn whose amount does not match the invoice', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ amount: 24_000_000n })),
    );
    expect(result).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('rejects a burn minting to someone other than the forwarder', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ mintRecipient: pad(DEPOSITOR, { size: 32 }) })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_recipient' });
  });

  it('rejects a burn aimed at a different destination domain', async () => {
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ destinationDomain: 0 })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_destination' });
  });

  it('rejects a burn of a token other than USDC', async () => {
    // A non-USDC burn (e.g. EURC) would mint an ERC-20 the forwarder cannot
    // forward as native value — it must never reach the relay.
    const result = await verifyBurn(
      invoice,
      BASE_DOMAIN,
      BURN_TX,
      mockClient(receiptWithBurn({ burnToken: '0x3333333333333333333333333333333333333333' })),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_token' });
  });

  it('rejects a missing receipt', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not found')),
    } as unknown as PublicClient;
    const result = await verifyBurn(invoice, BASE_DOMAIN, BURN_TX, client);
    expect(result).toEqual({ ok: false, reason: 'no_receipt' });
  });
});

describe('fetchAttestation', () => {
  it('returns pending while Iris has not indexed the burn (404)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'pending' });
  });

  it('returns pending while confirmations are outstanding', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: 'pending_confirmations', attestation: null }] }),
    });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'pending' });
  });

  it('returns the message and attestation once complete', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ status: 'complete', message: '0x1234', attestation: '0x5678' }],
      }),
    });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .resolves.toEqual({ status: 'complete', message: '0x1234', attestation: '0x5678' });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/${BASE_DOMAIN}?transactionHash=${BURN_TX}`,
    );
  });

  it('throws on a 5xx so the caller retries later', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchAttestation(BASE_DOMAIN, BURN_TX, fetchFn as unknown as typeof fetch))
      .rejects.toThrow();
  });
});
