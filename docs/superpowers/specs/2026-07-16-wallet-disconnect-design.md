# Wallet Disconnect & Merchant Sign-out — Design

**Problem:** Manual testing needs switching between merchant and customer wallets.
The dashboard pins the merchant to a 7-day httpOnly SIWE cookie with no way to clear
it, and the checkout page offers no way to disconnect the wagmi injected connection
or even see which account is connected.

## Design

1. **`POST /api/auth/logout`** (`web/app/api/auth/logout/route.ts`): deletes the
   `arcpay_session` cookie via a new `destroySession()` helper in `lib/session.ts`
   (symmetric with `createSession`). Returns 204. POST — not GET — so prefetchers
   cannot log the merchant out. No auth required: logging out unauthenticated is a
   no-op.
2. **Dashboard "Sign out"** button beside the merchant chip in the header:
   `POST /api/auth/logout` then `router.refresh()`; the server component re-reads
   the (now absent) session and renders `SignIn`.
3. **Checkout "Disconnect"** link under the payment controls in
   `app/pay/[id]/checkout.tsx`, showing the connected address
   (`0x1234…abcd · Disconnect`), wired to wagmi `useDisconnect`. Rendered only when
   connected and not mid-payment (hidden while `working` and while the bridge flow
   is past idle), so a connection is never dropped mid-flight. One instance in
   `checkout.tsx` covers both the Arc and Base Sepolia tabs.

**Honest limitation:** wagmi `disconnect()` clears the dapp side only; MetaMask
still remembers the site. Switching accounts still happens inside MetaMask — the
link gives a clean re-pick and the address label shows who you are.

**Verification:** route handlers using `cookies()` need a real request scope, so
the logout route is verified against the running dev server (Set-Cookie deletion
observed via curl / browser) rather than a mocked unit test. Dashboard flow is
verified in the browser with a signed session cookie; the checkout link's
connected state is exercised during manual wallet testing.
