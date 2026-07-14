import { beforeEach, describe, expect, it } from 'vitest';
import { signSession, verifySessionToken } from '@/lib/session';

const ADDRESS = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-at-least-32-bytes-long!!';
});

describe('session token', () => {
  it('round-trips the merchant address', async () => {
    const token = await signSession(ADDRESS);
    expect(await verifySessionToken(token)).toBe(ADDRESS.toLowerCase());
  });

  it('rejects a tampered token', async () => {
    const token = await signSession(ADDRESS);
    const tampered = `${token.slice(0, -4)}aaaa`;
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySessionToken('not-a-jwt')).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(ADDRESS);
    process.env.SESSION_SECRET = 'a-completely-different-secret-32b!!!';
    expect(await verifySessionToken(token)).toBeNull();
  });
});
