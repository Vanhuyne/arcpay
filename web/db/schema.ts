import { boolean, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
