import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { parseSiweMessage } from 'viem/siwe';
import { publicClient } from '@/lib/arc';
import { clearSiweNonce, createSession, SIWE_NONCE_COOKIE } from '@/lib/session';

export async function POST(req: Request) {
  const { message, signature } = await req.json();

  // The nonce we issued, not the one the caller claims. A message carrying any other
  // nonce is either a replay of an old login or a signature harvested elsewhere.
  const issuedNonce = (await cookies()).get(SIWE_NONCE_COOKIE)?.value;
  if (!issuedNonce) {
    return NextResponse.json({ error: 'no pending login' }, { status: 400 });
  }

  const parsed = parseSiweMessage(message);
  if (!parsed.address) {
    return NextResponse.json({ error: 'malformed message' }, { status: 400 });
  }

  // Bind the signature to this deployment. Without it, a signature the merchant produced
  // for some other site would be accepted here as a login.
  const domain = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? undefined;

  const valid = await publicClient.verifySiweMessage({
    message,
    signature,
    nonce: issuedNonce,
    domain,
  });
  if (!valid) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // One nonce, one login. Burn it whether or not the caller comes back.
  await clearSiweNonce();
  await createSession(parsed.address);

  return NextResponse.json({ address: parsed.address });
}
