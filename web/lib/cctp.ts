import {
  createPublicClient,
  decodeEventLog,
  http,
  pad,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import type { Invoice } from '@/db/schema';

export { baseSepolia };

/** CCTP v2 is deployed at the same addresses on every EVM chain. */
export const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
export const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;

export const ARC_DOMAIN = 26;
/** Standard transfer: minted amount equals burned amount, no fast-transfer fee. */
export const STANDARD_FINALITY = 2000;

export type SourceChain = {
  domain: number;
  chain: typeof baseSepolia;
  usdc: Address;
  rpcUrl: string;
};

/** Adding a source chain later = adding one entry here. */
export const SOURCE_CHAINS: Record<number, SourceChain> = {
  6: {
    domain: 6,
    chain: baseSepolia,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  },
};

export const TOKEN_MESSENGER_ABI = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'burnToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
      { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
      { name: 'hookData', type: 'bytes', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export function sourcePublicClient(domain: number): PublicClient {
  const source = SOURCE_CHAINS[domain];
  if (!source) throw new Error(`Unknown CCTP source domain: ${domain}`);
  // The cast is required: baseSepolia is an OP-stack chain whose type carries
  // deposit-transaction formatters, so its client is not assignable to the
  // generic PublicClient (arc.ts needs no cast — Arc has no custom formatters).
  // We only call getTransactionReceipt, which the cast does not affect.
  return createPublicClient({ chain: source.chain, transport: http(source.rpcUrl) }) as PublicClient;
}

export type BurnFailure =
  | 'unknown_domain'
  | 'no_receipt'
  | 'tx_reverted'
  | 'no_burn_log'
  | 'wrong_token'
  | 'wrong_recipient'
  | 'wrong_destination'
  | 'amount_mismatch';

export type VerifyBurnResult = { ok: true; depositor: Address } | { ok: false; reason: BurnFailure };

type DecodedBurn = {
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationCaller: Hex;
};

/**
 * The bridge twin of verify.ts: a burnTxHash from the browser is a HINT.
 * We re-read the receipt from the SOURCE chain and require the DepositForBurn
 * log to target our forwarder, our domain, and this invoice's exact amount
 * before any state change. The burn amount is 6-decimal USDC on the source
 * chain — the same unit as invoice.amount6, no conversion involved.
 */
export async function verifyBurn(
  invoice: Invoice,
  sourceDomain: number,
  burnTxHash: Hex,
  client?: PublicClient,
): Promise<VerifyBurnResult> {
  const source = SOURCE_CHAINS[sourceDomain];
  if (!source) return { ok: false, reason: 'unknown_domain' };

  const publicClient = client ?? sourcePublicClient(sourceDomain);

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: burnTxHash });
  } catch {
    return { ok: false, reason: 'no_receipt' };
  }
  if (!receipt) return { ok: false, reason: 'no_receipt' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };

  // Same load-bearing filter as verify.ts: only logs emitted by the real
  // TokenMessenger are believed.
  const messengerLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === TOKEN_MESSENGER.toLowerCase(),
  );

  let burn: DecodedBurn | null = null;
  for (const log of messengerLogs) {
    try {
      const ev = decodeEventLog({
        abi: TOKEN_MESSENGER_ABI,
        eventName: 'DepositForBurn',
        topics: log.topics,
        data: log.data,
      });
      burn = ev.args as DecodedBurn;
      break;
    } catch {
      // not a DepositForBurn log — keep looking
    }
  }
  if (!burn) return { ok: false, reason: 'no_burn_log' };

  // Only a USDC burn mints native value on Arc; any other token (EURC, …)
  // would strand as an ERC-20 the forwarder cannot forward.
  if (burn.burnToken.toLowerCase() !== source.usdc.toLowerCase()) {
    return { ok: false, reason: 'wrong_token' };
  }

  const forwarder32 = pad(FORWARDER_ADDRESS, { size: 32 }).toLowerCase();
  if (
    burn.mintRecipient.toLowerCase() !== forwarder32 ||
    burn.destinationCaller.toLowerCase() !== forwarder32
  ) {
    return { ok: false, reason: 'wrong_recipient' };
  }
  if (burn.destinationDomain !== ARC_DOMAIN) {
    return { ok: false, reason: 'wrong_destination' };
  }
  if (burn.amount !== invoice.amount6) {
    return { ok: false, reason: 'amount_mismatch' };
  }

  return { ok: true, depositor: burn.depositor.toLowerCase() as Address };
}

const IRIS_URL = process.env.IRIS_API_URL ?? 'https://iris-api-sandbox.circle.com';

export type Attestation =
  | { status: 'pending' }
  | { status: 'complete'; message: Hex; attestation: Hex };

/**
 * Circle's attestation service. 404 means "not indexed yet", not an error.
 * Anything 5xx throws so callers keep the row untouched and retry later.
 */
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: Hex,
  fetchFn: typeof fetch = fetch,
): Promise<Attestation> {
  const res = await fetchFn(
    `${IRIS_URL}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`,
  );
  if (res.status === 404) return { status: 'pending' };
  if (!res.ok) throw new Error(`Iris responded ${res.status}`);

  const data = await res.json();
  const msg = data.messages?.[0];
  if (!msg || msg.status !== 'complete' || !msg.attestation) return { status: 'pending' };
  return { status: 'complete', message: msg.message as Hex, attestation: msg.attestation as Hex };
}
