import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let instance: Db | null = null;

function connect(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  instance ??= drizzle(neon(url), { schema });
  return instance;
}

/**
 * Connects on first query, not on import.
 *
 * lib/invoices.ts exports pure helpers (invoiceStatus, newInvoiceId) alongside its
 * queries, and lib/dto.ts imports one of them. Opening the connection at module load
 * would make importing a pure function require a live DATABASE_URL — so the pure code
 * could not be unit-tested, and any bundle touching it would drag in the database.
 */
export const db: Db = new Proxy({} as Db, {
  get: (_target, prop, receiver) => Reflect.get(connect(), prop, receiver),
});
