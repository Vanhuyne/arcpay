/**
 * The single boundary between Arc's two views of USDC.
 *
 * Native (msg.value, gas): 18 decimals.
 * ERC-20 interface, our database, our API, our UI: 6 decimals.
 *
 * Same balance, two representations. No other file in this project may
 * convert between them.
 */
export const USDC_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;
export const USDC_SCALE = 10n ** BigInt(NATIVE_DECIMALS - USDC_DECIMALS); // 10^12

/** 6-decimal storage amount -> 18-decimal native amount (msg.value). */
export function toNative(amount6: bigint): bigint {
  return amount6 * USDC_SCALE;
}

/** 18-decimal native amount -> 6-decimal storage amount. Truncates dust. */
export function fromNative(wei: bigint): bigint {
  return wei / USDC_SCALE;
}

/** "5.00", "1.234567" — for display only. */
export function formatUsdc(amount6: bigint): string {
  const whole = amount6 / 1_000_000n;
  const frac = amount6 % 1_000_000n;
  if (frac === 0n) return `${whole}.00`;
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

/**
 * Format an 18-decimal native amount (gas fees) for display, e.g. "0.0084".
 * UI code must call this instead of dividing by 1e18 — Number() on an 18-decimal
 * bigint silently loses precision, which is the exact class of bug this module exists
 * to prevent.
 */
export function formatNativeUsdc(wei: bigint, precision = 4): string {
  const scale = 10n ** BigInt(NATIVE_DECIMALS - precision);
  const scaled = wei / scale;
  const whole = scaled / 10n ** BigInt(precision);
  const frac = scaled % 10n ** BigInt(precision);
  return `${whole}.${frac.toString().padStart(precision, '0')}`;
}

/** User input -> 6-decimal integer. Throws on anything we refuse to guess about. */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: ${input} (max 6 decimal places)`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const amount6 = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (amount6 <= 0n) throw new Error('Amount must be greater than zero');
  return amount6;
}
