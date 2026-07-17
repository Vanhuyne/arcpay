import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  publicActions,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '@/lib/arc';
import { FORWARDER_ABI, FORWARDER_ADDRESS } from '@/lib/forwarder';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';
import { toNative } from '@/lib/usdc';

const RPC_HTTP = process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network';

/**
 * Lazy on purpose (same reason as db/index.ts): importing this module must not
 * require RELAYER_PRIVATE_KEY, or every test touching lib/bridge.ts would.
 */
function relayerClient() {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set');
  return createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: arcTestnet,
    transport: http(RPC_HTTP),
  }).extend(publicActions);
}

/** The ops wallet's address — also the merchant of homepage demo invoices. */
export function relayerAddress(): Address {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set');
  return privateKeyToAccount(key as Hex).address;
}

/**
 * Pay an invoice from the ops wallet (homepage demo). Simulate first: the
 * router reverts a double-pay deterministically, so a race costs a failed
 * simulation, not gas. Arc blocks are sub-second — waiting keeps callers simple.
 */
export async function sendRouterPay(
  invoiceId: Hex,
  merchant: Address,
  amount6: bigint,
): Promise<Hex> {
  const client = relayerClient();
  const amountNative = toNative(amount6);
  const { request } = await client.simulateContract({
    address: ROUTER_ADDRESS,
    abi: PAYMENT_ROUTER_ABI,
    functionName: 'pay',
    args: [invoiceId, merchant, amountNative],
    value: amountNative,
  });
  const hash = await client.writeContract(request);
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Simulate first so a deterministic revert (AlreadySettled) surfaces as an
 * exception without burning gas, then send and wait for inclusion — Arc blocks
 * are sub-second, so waiting here keeps the state machine simple.
 */
export async function sendMintAndPay(
  message: Hex,
  attestation: Hex,
  invoiceId: Hex,
  merchant: Address,
): Promise<Hex> {
  const client = relayerClient();
  try {
    const { request } = await client.simulateContract({
      address: FORWARDER_ADDRESS,
      abi: FORWARDER_ABI,
      functionName: 'mintAndPay',
      args: [message, attestation, invoiceId, merchant],
    });
    const hash = await client.writeContract(request);
    await client.waitForTransactionReceipt({ hash });
    return hash;
  } catch (e) {
    // Deterministic revert: surface a stable message for the state machine.
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'AlreadySettled') {
        throw new Error('AlreadySettled');
      }
    }
    throw e;
  }
}
