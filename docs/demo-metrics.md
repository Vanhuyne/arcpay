# ArcPay — measured demo metrics (Arc Testnet)

All numbers below are from real transactions on Arc Testnet (chain `5042002`) against
the deployed app at <https://arcpay-theta.vercel.app>, not simulations.

## The real demo payment

A merchant charged 5.00 USDC ("two coffee") on the dashboard and it was paid in one
signature from a customer wallet.

| Field | Value |
|---|---|
| Amount | 5.00 USDC |
| Tx | [`0xf0a4580369023135b0f13f9ea87986e9ebb9283844c8e6a4d2b355a86908377b`](https://testnet.arcscan.app/tx/0xf0a4580369023135b0f13f9ea87986e9ebb9283844c8e6a4d2b355a86908377b) |
| Block | 51708115 |
| Merchant (received funds) | `0x11308546424b26b6b3b24fd1023f513f5c388900` |
| Payer (sent tx, paid gas) | `0x138F8cA8A5fcE867B9Cf5E83eF817236D93Ea53d` |
| Gas fee | **0.0011 USDC** (1,151,682,800,000,000 wei · gasUsed 57,014) |
| Settled after deadline? | no |

## Time to finality — read this carefully

Two different numbers, and the difference is the whole point of being honest here.

**Chain finality (submit → final): ~0.77s.** This is what "settled in under a second"
claims — the time from the signed transaction hitting the wire to its receipt being
final. Measured over 5 back-to-back scripted payments (no human in the loop):

| Run | submit → final |
|---|---|
| 1 | 0.76s |
| 2 | 4.84s (outlier — missed a block) |
| 3 | 0.79s |
| 4 | 0.78s |
| 5 | 0.76s |

Typical **~0.77s**, min **0.75s**. One run in five hit a multi-block delay (4.84s);
Arc's finality is sub-second in the common case but not guaranteed every single time.

**End-to-end wall clock (tap Pay → success screen): 5.68s** on the first real demo run.
Almost all of that was the customer reading and confirming the transaction in their
wallet — human time, not Arc. The original checkout stopwatch started at the Pay tap and
so counted that wallet time as "time to final", which misrepresents the chain. It was
fixed ([`e5aea1c`](.)) to start the clock when the signed tx is submitted, so the
on-screen "X.XX s to final" now shows chain settlement (~0.77s), matching the numbers
above.

## Spec §11 success criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | POS flips measurably in under one second | ✅ chain finality ~0.77s (5-run measurement); POS detects via WebSocket event + a 400 ms poll fallback | table above; POS poll flip verified in a browser (Task 10) |
| 2 | Customer holds only USDC — no second token, no approval, one signature | ✅ single `pay()` with `value = amount`; gas paid in USDC (0.0011); no `approve`, no other asset | the real tx above |
| 3 | Server trusts no client — every forgery in §10.2 rejected | ✅ `verify.test.ts` (9 cases incl. the Arc native-USDC precompile log); `/confirm` rejected a real-but-lying txHash with `invoice_mismatch` | `pnpm vitest run test/verify.test.ts`; Task 8 API e2e |
| 4 | Merchant pays no gas and signs nothing across the lifecycle | ✅ merchant `0x1130…8900` signed only the SIWE message (no on-chain tx); the payment's sender was the payer `0x138f…a53d`, who paid the 0.0011 USDC gas | `cast tx … from` = payer; merchant received the 5 USDC |
| 5 | UI surfaces gas fee in USDC and time-to-finality | ✅ dashboard row shows `gas 0.0011 USDC`; checkout success shows `X.XX s to final` | Tasks 9 & 11 screenshots |

## Reproduce the finality measurement

Pay through the deployed `PaymentRouter` in a loop with a funded key and time each
`writeContract → waitForTransactionReceipt`: that window is submit → final, with no wallet
UI in the path. Five runs gave the table above. The on-screen number in the checkout
measures the same window (from the moment the signed tx is submitted), so a live payment
shows the same ~0.77s rather than the wall-clock that includes wallet-confirm time.
