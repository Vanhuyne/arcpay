import { describe, expect, it } from 'vitest';
import { formatNativeUsdc, formatUsdc, fromNative, parseUsdc, toNative, USDC_SCALE } from '@/lib/usdc';

describe('usdc decimals boundary', () => {
  it('scales by exactly 10^12 (18 - 6)', () => {
    expect(USDC_SCALE).toBe(10n ** 12n);
  });

  it('converts 5 USDC from 6-decimal storage to 18-decimal native', () => {
    expect(toNative(5_000_000n)).toBe(5_000_000_000_000_000_000n);
  });

  it('round-trips without loss', () => {
    for (const a of [0n, 1n, 5_000_000n, 999_999_999_999n]) {
      expect(fromNative(toNative(a))).toBe(a);
    }
  });

  it('truncates native dust below 1 micro-USDC to zero', () => {
    // Arc's ERC-20 view drops sub-6-decimal precision. We must behave the same way
    // or a payment that "looks" correct on chain will mismatch our record.
    expect(fromNative(999_999_999_999n)).toBe(0n);
  });

  it('formats 6-decimal amounts for display', () => {
    expect(formatUsdc(5_000_000n)).toBe('5.00');
    expect(formatUsdc(1_234_567n)).toBe('1.234567');
    expect(formatUsdc(0n)).toBe('0.00');
  });

  it('formats an 18-decimal native amount (the gas fee) without losing precision', () => {
    // The dashboard must never do this division itself with Number().
    expect(formatNativeUsdc(10_000_000_000_000_000n)).toBe('0.0100');
    expect(formatNativeUsdc(8_432_000_000_000_000n)).toBe('0.0084');
    expect(formatNativeUsdc(0n)).toBe('0.0000');
  });

  it('parses user input into 6-decimal integers', () => {
    expect(parseUsdc('5')).toBe(5_000_000n);
    expect(parseUsdc('5.00')).toBe(5_000_000n);
    expect(parseUsdc('0.01')).toBe(10_000n);
  });

  it('rejects input with more than 6 decimal places', () => {
    expect(() => parseUsdc('1.1234567')).toThrow();
  });

  it('rejects non-positive amounts', () => {
    expect(() => parseUsdc('0')).toThrow();
    expect(() => parseUsdc('-1')).toThrow();
  });
});
