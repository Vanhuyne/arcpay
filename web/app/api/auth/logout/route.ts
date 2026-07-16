import { destroySession } from '@/lib/session';

/** POST, not GET: a prefetcher must never be able to sign the merchant out. */
export async function POST() {
  await destroySession();
  return new Response(null, { status: 204 });
}
