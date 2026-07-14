import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { generateSiweNonce } from 'viem/siwe';
import { SIWE_NONCE_COOKIE, SIWE_NONCE_TTL_SECONDS } from '@/lib/session';

/**
 * A nonce is only worth anything if we can later prove we were the ones who issued it.
 * We therefore hand it to the browser AND bind it to an httpOnly cookie; /api/auth/siwe
 * refuses any message whose nonce does not match that cookie. Without this the nonce is
 * decorative and a captured (message, signature) pair could be replayed forever.
 */
export async function GET() {
  const nonce = generateSiweNonce();

  (await cookies()).set(SIWE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SIWE_NONCE_TTL_SECONDS,
  });

  return NextResponse.json({ nonce });
}
