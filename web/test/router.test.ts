import { describe, expect, it } from 'vitest';
import { getAbiItem, isAddress } from 'viem';
import { PAYMENT_ROUTER_ABI, ROUTER_ADDRESS } from '@/lib/router';

describe('payment router binding', () => {
  it('exposes a deployed router address', () => {
    expect(isAddress(ROUTER_ADDRESS)).toBe(true);
  });

  it('exposes pay(bytes32,address,uint256) as payable', () => {
    const pay = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'pay' });
    expect(pay?.stateMutability).toBe('payable');
    expect(pay?.inputs.map((i) => i.type)).toEqual(['bytes32', 'address', 'uint256']);
  });

  it('exposes the InvoicePaid event with three indexed fields', () => {
    const ev = getAbiItem({ abi: PAYMENT_ROUTER_ABI, name: 'InvoicePaid' });
    expect(ev?.inputs.filter((i) => 'indexed' in i && i.indexed)).toHaveLength(3);
  });
});
