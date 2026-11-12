# Releases

A release is a git tag `portal-contracts-v<version>` on `main`. The tagged commit holds everything another project needs to talk to the deployed contracts:

| Path | What it is |
|---|---|
| `abi/<Contract>.json` | ABI of each deployed contract |
| `deployments/<chainId>.json` | Addresses, start blocks and deployment transactions |
| `layout/<Contract>.json` | Storage layout of each upgradeable contract |

`abi/` and `layout/` are generated. CI fails when they differ from what the sources build to, so they are never edited by hand.

## Using a release from another project

Pin a tag and copy the files from it. Do not copy from `main`: `main` can hold contract changes that are not deployed yet.

```
https://raw.githubusercontent.com/subsquid/subsquid-network-contracts/portal-contracts-v1.2.0/packages/portal-contracts/abi/PortalRegistry.json
https://raw.githubusercontent.com/subsquid/subsquid-network-contracts/portal-contracts-v1.2.0/packages/portal-contracts/deployments/42161.json
```

Things to know when reading `deployments/<chainId>.json`:

- `startBlock` is the block the contract was deployed in. An indexer can start there.
- Pools are not listed. The factory creates each pool as a beacon proxy and emits `PoolCreated`; a pool's ABI is `PortalPoolImplementation`, and its receipt token's ABI is `LiquidPortalToken`.
- A contract marked `"retired": true` is no longer used by the factory, but it emitted events while it was.
- `"version": null` means the chain runs builds that were never released. `deployments/421614.json` (Arbitrum Sepolia) is in that state: the ABIs here may lack functions the testnet contracts have, and implementation addresses are not listed.
- An indexer needs every event the contracts have ever emitted. When a release removes or changes an event, keep the older ABI as well.

## Tools

Run these in `packages/portal-contracts`. Foundry must be the version in `.foundry-version`.

| Command | What it does |
|---|---|
| `pnpm artifacts` | Builds and rewrites `abi/` and `layout/` |
| `pnpm check:live` | Checks `deployments/42161.json` against Arbitrum One: addresses, wiring, implementation pointers, and that the deployed code equals the local build |
| `pnpm check:upgrade-safety [<baseline dir>]` | Runs OpenZeppelin's upgrade validator. With a checkout of the last release as `<baseline dir>`, it also checks that storage only grew at the end. Needs `(cd tools && npm ci --ignore-scripts)` once |

CI runs all three: the first and third on every pull request that touches the package (`.github/workflows/portal-contracts.yml`), the second once a day and on changes to `deployments/` (`.github/workflows/portal-contracts-live.yml`).

## Making a release

Contracts are deployed by hand, so a release records a deployment that has already happened.

1. Deploy or upgrade, and write the report in `upgrades/`.
2. In one pull request:
   - set `version` in `package.json` and in `deployments/42161.json`;
   - update the addresses in `deployments/42161.json` (new implementations, new contracts with their `startBlock` and `deployTx`);
   - update the address table in the repository's root `Readme.md`;
   - run `pnpm artifacts` if the sources changed since the files were last generated.
3. The live check on that pull request builds the pull request's own sources and compares them with the chain. It must pass.
4. Merge, then tag the merge commit: `git tag portal-contracts-v<version> <commit> && git push origin portal-contracts-v<version>`.

From then on the daily check builds the tag and compares it with the chain, and the upgrade-safety check compares every pull request with that tag.

Do not use pre-release suffixes (`-rc1`) in these tags. CI picks the last release by sorting the tag names as versions.
