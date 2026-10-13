---
name: testnet-rewards
description: >-
  Pay the quarterly testnet (tethys) worker rewards: build the merkle tree from the testnet squid, deploy and fund a MerkleDistributor on Arbitrum One, publish the claim file via subsquid/cdn, check claim.tethys.sqd.dev, sweep old distributors. Use for "testnet rewards", "tethys rewards Q3", "airdrop contract", "claim page shows the wrong period".
---

# Quarterly testnet worker rewards

Testnet worker operators receive real SQD every quarter. Each quarter gets its own
`MerkleDistributor` on Arbitrum One. The claim page (claim.tethys.sqd.dev) reads one file,
`points/testnet-rewards/current.json` in `gs://subsquid-public`, for the contract, the period and the tree,
and computes proofs in the browser. So a new quarter needs no change to the frontend or to the API.

The full procedure, with every flag, is in
[packages/testnet-rewards/README.md](../../../packages/testnet-rewards/README.md). The script is
[packages/testnet-rewards/testnet-rewards.ts](../../../packages/testnet-rewards/testnet-rewards.ts).
This skill adds the things the README does not say: access, the checks between the steps, and the traps.

## Before you start

- **Access.** The human runs every transaction, never the agent. Collect the access first:
  - Any account with ETH on Arbitrum One to deploy; the deployer does not matter, the owner argument does (`publish` checks it).
  - The holder of the testnet rewards budget, who sends the printed total to the contract.
  - `sqd` CLI access to the `subsquid` org in SQD Cloud, for the read-only squid URI.
  - A [subsquid/cdn](https://github.com/subsquid/cdn) checkout on an up-to-date `main`, and the right to open a PR there. Nobody uploads to GCS directly.
- **Squid lag.** The quarter must be complete in the `subsquid-network-testnet` squid. `build` aborts when the squid has not indexed past the period end. Do not use `--allow-incomplete` for a real payout. If the squid is stuck, fix the squid first.
- **Period end.** The period is `[first day of quarter, first day of next quarter)`. Up to Q2 2026 the last day of the quarter was dropped by mistake. Do not "fix" it back.

## Steps

1. `build --quarter <YYYY-QN> --cdn-dir <cdn checkout>` (from `packages/testnet-rewards`). Read the printed summary before you continue:
   - The "Compared with" line names where the previous quarter was read. If it says public bucket, rerun with `--cdn-dir`. A `NOT COMPARED` warning is expected only for the first quarter.
   - `window` must say `CONTIGUOUS`. On `GAP` (days nobody is paid for) or `OVERLAP` (days paid twice), stop and ask the human; a missed day can be folded in with `--from` (see the README).
   - The payout total is budget / price by construction, so it proves nothing. Look at the wallets: every `new` and `gone` wallet, and a large change in the count, needs an explanation before anyone deploys.
   - Show the comparison to the human.
2. The human runs the printed `forge create` command from `packages/contracts` with their own signer, constructor arguments unchanged. Record the deployed address.
3. The holder of the testnet rewards budget transfers exactly the printed total to the contract. Optionally, send a small test amount first.
4. Run `publish --quarter … --contract 0x… --cdn-dir <cdn checkout>`. Then open the cdn PR with the printed git commands. That PR is the record of the payout: it adds `<quarter>.summary.json` (price, parameters, root, total) next to `current.json`, and nothing is committed in this repo. When the PR merges, CI uploads the file with `Cache-Control: no-cache`.

## Check that the claim page uses the new quarter

- `curl -s https://storage.googleapis.com/subsquid-public/points/testnet-rewards/current.json | jq '.contract, .periodStart, .periodEnd'` returns the new values.
- `cast call <contract> "merkleRoot()(bytes32)" --rpc-url https://arb1.arbitrum.io/rpc` equals the tree root, `jq -r '.tree.tree[0]'` on that file. The claim page compares the two. On a mismatch it shows "Rewards are being updated" and offers no claim button.
- Open claim.tethys.sqd.dev with any wallet from `rewards.csv`. It shows the new period and amount.

## Sweep old distributors

A per-quarter contract keeps the unclaimed SQD forever. Its owner (`0x24B97D7eE13Abc7c1fc109Ea66CabdcBe3ADe1a7`)
can call `withdrawAll()`, which sends the full balance to the owner.
- After a claim window agreed with the human (for example, when the next quarter is published), list the old
  contracts with a balance: the archive files `src/points/0x*.json` in subsquid/cdn, plus the git history of
  `src/api/points.ts` in subsquid/network-points-landing for quarters before Q3 2026.
- Prepare `cast send <old contract> "withdrawAll()" --account <owner signer>` for the human.
- Do not sweep the contract that `current.json` names: its claims are live.

## Traps

- The claim page reads only `current.json`. The archive file `src/points/<contract>.json` is for history, not for the page.
- If the page shows "temporarily unavailable", the browser could not load or validate `current.json`. Check bucket CORS (`curl -sI -H 'Origin: https://claim.tethys.sqd.dev' <url>` must return `access-control-allow-origin`) and the JSON.
- Never edit `current.json` by hand. The page rehashes the full tree and refuses a file with edited amounts.
