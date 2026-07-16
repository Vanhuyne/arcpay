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
