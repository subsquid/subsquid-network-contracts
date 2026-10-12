# Testnet rewards

Every quarter, testnet (tethys) workers are paid in real SQD on Arbitrum One through a fresh [`MerkleDistributor`](../contracts/src/MerkleDistributor.sol). The budget is 25 workers × $225 at the quarter's SQD/USD price, split pro rata by each owner's testnet rewards.

[`testnet-rewards.ts`](./testnet-rewards.ts) does the data side. You deploy and fund the contract yourself with the commands it prints; the script never sends a transaction. The record of every payout is in [subsquid/cdn](https://github.com/subsquid/cdn) under `src/points/`. Nothing is committed here.

## Quarterly steps

Run `pnpm i` at the repo root once. Run the script from this directory with [Bun](https://bun.sh).

1. **Build.** Point it at the read-only Postgres of the `subsquid-network-testnet` squid and build the quarter:

   ```bash
   export TESTNET_SQUID_PG_URL=$(sqd view -o subsquid -n subsquid-network-testnet -t prod --json --no-interactive \
     | jq -r '.addons.postgres.connections[] | select(.type=="read") | .uri')
   bun testnet-rewards.ts build --quarter 2026-Q3 --cdn-dir ~/dev/subsquid/cdn
   ```

   - **Period:** from the first day of the quarter up to, but not including, the first day of the next one. The build aborts if the squid hasn't indexed past the end of the period.
   - **Price:** the time-weighted average (TWAP) of CoinGecko's hourly SQD/USD over the whole calendar quarter. Set `COINGECKO_API_KEY` (demo key) for quarters older than 365 days.
   - **Overrides:** `--price` for the price; `--workers` and `--target-usd` for the budget; `--from/--to` (exclusive end) for the data window; `--from-csv` to read a per-wallet CSV instead of the squid.

   It writes `out/<quarter>/{rewards.csv,tree.json,summary.json}` (gitignored) and prints the root and the total. It then compares the result with the previous quarter's published summary, read from `--cdn-dir` or, without it, from the public bucket. Last, it prints the commands for the next two steps.
2. **Deploy and verify.** From `packages/contracts`, run the printed `forge create … --verify --verifier sourcify` command (`--account sqd-ops`).
3. **Fund** the contract with the printed `cast send <SQD> "transfer(address,uint256)" <contract> <total>` command.
4. **Publish.** Check the contract and write the cdn files:

   ```bash
   bun testnet-rewards.ts publish --quarter 2026-Q3 --contract 0x… --cdn-dir ~/dev/subsquid/cdn
   ```

   It aborts unless:
   - the contract's `merkleRoot()` matches the tree,
   - its `token()` is SQD,
   - its SQD balance covers everything still claimable.

   It then writes three files into the cdn checkout and prints the git commands for the cdn PR. Merging that PR uploads them to `gs://subsquid-public`.

| File in `subsquid/cdn` | Contents |
|---|---|
| `src/points/testnet-rewards/current.json` | What the claim page reads: contract, period, total and the full tree (schema `version: 1`). |
| `src/points/testnet-rewards/<quarter>.summary.json` | How the quarter was computed: price and its source, parameters, data window, root, total, wallet count, contract. |
| `src/points/<contract>.json` | The plain `StandardMerkleTree` dump, kept per contract for history and the legacy proof API. |

## Development

```bash
pnpm test   # bun test: TWAP unit tests
pnpm lint   # tsc
```
