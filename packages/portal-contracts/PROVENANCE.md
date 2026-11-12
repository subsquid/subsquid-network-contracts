# Provenance

This directory is the only maintained copy of the portal pool contracts.

The code was written in a separate repository, `subsquid/sqd-portal-contracts`, and moved here in 2026. That repository is no longer maintained. It is kept only for its pull request discussions and for branches that were never merged.

## How the code got here

| Commit | Date | What happened |
|---|---|---|
| `37c7f7f` | 2026-04-27 | Subtree merge of the old repository's `main` (at `1fa981a`) into `packages/portal-contracts` |
| `91567c5` | 2026-05-11 | Second and last subtree merge, of the old `main` at `e5c8a0a` |

After the second merge this directory was identical, file for file, to the old repository at `e5c8a0a`. Every commit of the old `main` is part of this repository's history under its original hash.

`494f149` is the last commit of the February 2026 security review fixes. To see what changed in the contracts since then:

```sh
git diff 494f149:src HEAD:packages/portal-contracts/src
```

## Reading the history of a file

Commits made before the import changed files at the old repository's root (`src/…`, not `packages/portal-contracts/src/…`). A plain `git log` on the new path therefore stops at the import, and so does the file history on GitHub.

```sh
# History before the import. The path is relative to the old repository root.
git log e5c8a0a -- src/PortalRegistry.sol

# History since the import.
git log -- packages/portal-contracts/src/PortalRegistry.sol

# Blame works across the import without any extra flags.
git blame packages/portal-contracts/src/PortalRegistry.sol
```

## Deployment records

`broadcast/` and `upgrades/` were imported with the code. Each `broadcast/**/run-*.json` names the commit it was deployed from in its `commit` field. Two of those commits, `0e18528` and `89ca913`, were never merged into `main` and exist only in the old repository.
