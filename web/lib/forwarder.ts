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
] as const;

export const FORWARDER_ADDRESS = process.env.NEXT_PUBLIC_FORWARDER_ADDRESS as Address;

if (!FORWARDER_ADDRESS) {
  throw new Error('NEXT_PUBLIC_FORWARDER_ADDRESS is not set — deploy CrossPayForwarder first');
}
