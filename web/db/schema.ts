import { boolean, integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const merchants = pgTable('merchants', {
  address: text('address').primaryKey(), // lowercase; checksummed only for display
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(), // random 32-byte hex, used directly as bytes32
  merchant: text('merchant').notNull(),
  amount6: numeric('amount6', { mode: 'bigint' }).notNull(), // 6 decimals — see lib/usdc.ts
  description: text('description').notNull(),
  status: text('status', { enum: ['pending', 'paid'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  // populated only by lib/verify.ts
  txHash: text('tx_hash'),
  payer: text('payer'),
  blockNumber: numeric('block_number', { mode: 'bigint' }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  gasFee: numeric('gas_fee', { mode: 'bigint' }), // 18 decimals — the "fee paid in USDC" story
  wasLate: boolean('was_late').notNull().default(false),
});

export type Invoice = typeof invoices.$inferSelect;

/**
 * One row per verified CCTP burn. Unlike invoice expiry, `status` is stored:
 * every step records an external fact we already observed (a receipt, an
 * attestation, a mint tx), not a value derivable at read time.
 * burn_confirmed -> attested -> paid | failed
 * (`burn_submitted` never persists: the server only inserts verified burns.)
 */
export const bridgePayments = pgTable('bridge_payments', {
  burnTxHash: text('burn_tx_hash').primaryKey(), // primary key = replay protection
  invoiceId: text('invoice_id').notNull(),
  sourceDomain: integer('source_domain').notNull(),
  amount6: numeric('amount6', { mode: 'bigint' }).notNull(),
  depositor: text('depositor').notNull(), // customer on the source chain; rescue() refund target
  status: text('status', { enum: ['burn_confirmed', 'attested', 'paid', 'failed'] })
    .notNull()
    .default('burn_confirmed'),
  message: text('message'), // hex CCTP message, set when attested
  attestation: text('attestation'), // hex, set when attested
  mintTxHash: text('mint_tx_hash'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BridgePayment = typeof bridgePayments.$inferSelect;
