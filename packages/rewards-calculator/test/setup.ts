/**
 * Loaded before every spec (see `setupFiles` in vitest.config.ts).
 *
 * `src/config.ts` validates its environment at import time and throws on any
 * missing variable, so importing anything that transitively reaches it — which
 * is most of the pipeline — fails outside a configured deployment. These are
 * inert placeholders: no test performs network or ClickHouse I/O.
 */
const placeholders: Record<string, string> = {
  CLICKHOUSE_PASSWORD: 'test',
  FORDEFI_ACCESS_TOKEN: 'test',
  FORDEFI_VAULT_ID: 'test',
  L1_RPC_URL: 'http://127.0.0.1:0',
  L2_RPC_URL: 'http://127.0.0.1:0',
};

for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value;
}
