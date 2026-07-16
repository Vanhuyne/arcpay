import type { Address } from 'viem';

export const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'mintAndPay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'merchant', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rescue',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  // Errors are needed so viem can decode reverts from simulateContract.
  // AlreadySettled is PaymentRouter's error, bubbled through mintAndPay.
  { type: 'error', name: 'AlreadySettled', inputs: [] },
  { type: 'error', name: 'OnlyRelayer', inputs: [] },
  { type: 'error', name: 'ReceiveFailed', inputs: [] },
  { type: 'error', name: 'NothingMinted', inputs: [] },
  { type: 'error', name: 'RescueFailed', inputs: [] },
] as const;

export const FORWARDER_ADDRESS = process.env.NEXT_PUBLIC_FORWARDER_ADDRESS as Address;

if (!FORWARDER_ADDRESS) {
  throw new Error('NEXT_PUBLIC_FORWARDER_ADDRESS is not set — deploy CrossPayForwarder first');
}
