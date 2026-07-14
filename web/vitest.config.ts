import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';

export default defineConfig(({ mode }) => ({
  // Next.js loads .env.local into process.env at runtime; vitest does not, and Vite's
  // default envPrefix would filter out NEXT_PUBLIC_*. The empty prefix loads every key,
  // so lib/router.ts sees the same NEXT_PUBLIC_ROUTER_ADDRESS under test as in the app.
  test: { environment: 'node', env: loadEnv(mode, process.cwd(), '') },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
}));
