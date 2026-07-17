import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { arcTestnet } from 'viem/chains';

export { arcTestnet };

export const ARC_EXPLORER_URL = 'https://testnet.arcscan.app';

const RPC_HTTP = process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network';
const RPC_WS = process.env.NEXT_PUBLIC_ARC_RPC_WS ?? 'wss://rpc.testnet.arc.network';

/** Server-side reads: receipts, logs. */
export const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_HTTP),
});

/** Browser-side event subscription for the POS screen. */
export function createWsClient(): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: webSocket(RPC_WS) });
}

export function txUrl(hash: string): string {
  return `${ARC_EXPLORER_URL}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${ARC_EXPLORER_URL}/address/${address}`;
}
