import { describe, expect, it } from 'vitest';
import { FORWARDER_ABI, FORWARDER_ADDRESS } from '@/lib/forwarder';

describe('forwarder binding', () => {
  it('exposes a deployed address', () => {
    expect(FORWARDER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('carries mintAndPay and rescue in the ABI', () => {
    const names = FORWARDER_ABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).toContain('mintAndPay');
    expect(names).toContain('rescue');
  });
});
