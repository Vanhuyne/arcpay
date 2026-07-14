import { cookies } from 'next/headers';
import { jwtVerify, SignJWT } from 'jose';
import type { Address } from 'viem';

export const SESSION_COOKIE = 'arcpay_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Single-use, server-issued SIWE nonce. See app/api/auth/nonce/route.ts. */
export const SIWE_NONCE_COOKIE = 'arcpay_siwe_nonce';
export const SIWE_NONCE_TTL_SECONDS = 300;

export async function clearSiweNonce(): Promise<void> {
  (await cookies()).delete(SIWE_NONCE_COOKIE);
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(s);
}

export async function signSession(address: string): Promise<string> {
  return new SignJWT({ sub: address.toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

export async function createSession(address: Address): Promise<void> {
  const token = await signSession(address);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

/** The merchant address for the current request, or null if not signed in. */
export async function readSession(): Promise<Address | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const sub = await verifySessionToken(token);
  return (sub as Address) ?? null;
}
