import { getAbiItem, type Address } from 'viem';

export const PAYMENT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'payable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'merchant', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settled',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'InvoicePaid',
    inputs: [
      { name: 'invoiceId', type: 'bytes32', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
] as const;

export const INVOICE_PAID_EVENT = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'InvoicePaid' });

export const ROUTER_ADDRESS = process.env.NEXT_PUBLIC_ROUTER_ADDRESS as Address;

if (!ROUTER_ADDRESS) {
  throw new Error('NEXT_PUBLIC_ROUTER_ADDRESS is not set — deploy the contract first');
}
