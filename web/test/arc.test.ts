import { describe, expect, it } from 'vitest';
import { ARC_EXPLORER_URL, arcTestnet } from '@/lib/arc';

describe('arc chain config', () => {
  it('is Arc Testnet', () => {
    expect(arcTestnet.id).toBe(5042002);
  });

  it('uses USDC as native currency with 18 decimals', () => {
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC');
    expect(arcTestnet.nativeCurrency.decimals).toBe(18);
  });

  it('points at ArcScan', () => {
    expect(ARC_EXPLORER_URL).toBe('https://testnet.arcscan.app');
  });
});
