import { and, eq, inArray } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { db } from '@/db';
import { bridgePayments, type BridgePayment, type Invoice } from '@/db/schema';
import { fetchAttestation } from '@/lib/cctp';
import { sendMintAndPay } from '@/lib/relayer';
import { verifyPayment, type VerifyResult } from '@/lib/verify';

export async function createBridgePayment(input: {
  burnTxHash: Hex;
  invoiceId: string;
  sourceDomain: number;
  amount6: bigint;
  depositor: Address;
}): Promise<BridgePayment> {
  const [row] = await db
    .insert(bridgePayments)
    .values({
      burnTxHash: input.burnTxHash.toLowerCase(),
      invoiceId: input.invoiceId,
      sourceDomain: input.sourceDomain,
      amount6: input.amount6,
      depositor: input.depositor.toLowerCase(),
    })
    .returning();
  return row;
}

export async function getBridgePayment(invoiceId: string): Promise<BridgePayment | null> {
  const [row] = await db
    .select()
    .from(bridgePayments)
    .where(eq(bridgePayments.invoiceId, invoiceId))
    .limit(1);
  return row ?? null;
}

export async function listUnfinishedBridgePayments(): Promise<BridgePayment[]> {
  return db
    .select()
    .from(bridgePayments)
    .where(inArray(bridgePayments.status, ['burn_confirmed', 'attested']));
}

async function update(
  burnTxHash: string,
  fromStatus: BridgePayment['status'],
  set: Partial<typeof bridgePayments.$inferInsert>,
): Promise<BridgePayment> {
  const [row] = await db
    .update(bridgePayments)
    .set({ ...set, updatedAt: new Date() })
    // status-guarded like markPaid: concurrent advances (poll + cron) stay idempotent
    .where(and(eq(bridgePayments.burnTxHash, burnTxHash), eq(bridgePayments.status, fromStatus)))
    .returning();
  return row;
}

export type AdvanceDeps = {
  fetchAttestation: typeof fetchAttestation;
  sendMintAndPay: typeof sendMintAndPay;
  /** Wraps verify.ts — the ONE verifier. The full result matters: only a
   *  deterministic mismatch may kill the row; no_receipt is a lagging RPC. */
  confirmPayment: (invoice: Invoice, mintTxHash: Hex) => Promise<VerifyResult>;
};

const defaultDeps: AdvanceDeps = {
  fetchAttestation,
  sendMintAndPay,
  confirmPayment: (invoice, mintTxHash) => verifyPayment(invoice, mintTxHash),
};

/**
 * Advance the state machine ONE non-blocking step. Called from the browser's
 * poll and from cron; never waits on the ~60s attestation, never loops.
 */
export async function advanceBridgePayment(
  bp: BridgePayment,
  invoice: Invoice,
  deps: AdvanceDeps = defaultDeps,
): Promise<BridgePayment> {
  if (bp.status === 'burn_confirmed') {
    const att = await deps.fetchAttestation(bp.sourceDomain, bp.burnTxHash as Hex);
    if (att.status !== 'complete') return bp;
    return (
      (await update(bp.burnTxHash, 'burn_confirmed', {
        status: 'attested',
        message: att.message,
        attestation: att.attestation,
      })) ?? bp
    );
  }

  if (bp.status === 'attested') {
    // A stored mintTxHash means the mint already landed and only verification
    // is outstanding — never send the (consumed) CCTP message again.
    let mintTxHash = bp.mintTxHash as Hex | null;
    if (!mintTxHash) {
      try {
        mintTxHash = await deps.sendMintAndPay(
          bp.message as Hex,
          bp.attestation as Hex,
          bp.invoiceId as Hex,
          invoice.merchant as Address,
        );
      } catch (e) {
        // Deterministic dead end: the triple is already settled on the router.
        // The relayer refunds via rescue() manually; everything else retries.
        if ((e as Error).message.includes('AlreadySettled')) {
          return (
            (await update(bp.burnTxHash, 'attested', {
              status: 'failed',
              failureReason: 'already_settled',
            })) ?? bp
          );
        }
        return bp;
      }
    }

    // The mint landed, but paid is terminal — only record it once the ONE
    // verifier has actually flipped the invoice.
    const result = await deps.confirmPayment(invoice, mintTxHash);
    if (result.ok) {
      return (
        (await update(bp.burnTxHash, 'attested', { status: 'paid', mintTxHash })) ?? bp
      );
    }
    if (result.reason === 'no_receipt') {
      // The relayer waited for inclusion, so the receipt exists — this read
      // hit a lagging replica. Keep the hash, stay attested, re-verify later.
      return (await update(bp.burnTxHash, 'attested', { mintTxHash })) ?? bp;
    }
    // A real divergence (wrong amount, wrong merchant, reverted mint): surface
    // it, don't bury it under 'paid'.
    return (
      (await update(bp.burnTxHash, 'attested', {
        status: 'failed',
        failureReason: `verify_failed:${result.reason}`,
        mintTxHash,
      })) ?? bp
    );
  }

  return bp; // paid | failed: terminal
}
