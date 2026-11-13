# 1.2.0 -> 1.3.0 Pre-Deploy Plan (PortalRegistry only)

Date: 2026-11-12

## Status

Not executed. This is the plan and the fork rehearsal for upgrading PortalRegistry so that third parties can run portal pools. There is no external audit of this change.

## Network

- chain: Arbitrum One
- chain id: `42161`
- admin (sole `DEFAULT_ADMIN_ROLE` holder): `0x5800eEB867D6c490051321239E15C3ac90e801C1`, the admin vault (an MPC wallet). It has no contract code on-chain, but it is not a single-key EOA. Every admin call in this plan, rollback included, is signed from this vault.
- portal manager: `PORTAL_MANAGER_ROLE` is granted to the same vault at deploy

## Target

- registry proxy: `0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850` (UUPS, `_authorizeUpgrade` requires `DEFAULT_ADMIN_ROLE`)
- current registry implementation: `0xC3725B2584ad46c52F9EFA6f27d0291e3DBC3045` (1.2.0)
- new registry implementation: deployed by `script/UpgradePortalRegistry.s.sol`; the address comes from that broadcast

## Contracts Touched

- `src/PortalRegistry.sol` (new implementation behind the existing proxy)
- `src/libs/PortalRegistryErrors.sol` (three new errors)
- `src/interfaces/IPortalRegistry.sol` (one new function, `forceRemovePortal`)

Not touched: factory, pool implementation and beacon, FeeRouter modules, LiquidPortalToken. Their compiled runtime bytecode is byte-identical to `b379b86`, so nothing else needs redeploying.

## Changes

1. `addPortal(bytes32,bytes,string)` is callable only by the new `PORTAL_MANAGER_ROLE` (`keccak256("PORTAL_MANAGER_ROLE")` = `0x47ce7f42ed0dcf5a065179619cbdec6b114f043d529ee4d28ca1dfc72e825cef`, role admin `DEFAULT_ADMIN_ROLE`). Cluster operators get `AccessControlUnauthorizedAccount`. Same signature; still `whenNotPaused`. SQD checks peer-ID ownership off-chain before calling it. The role goes to the admin vault, so each later `addPortal` and `forceRemovePortal` is also a contract call signed from that vault.
2. `forceRemovePortal(bytes peerId)`, `PORTAL_MANAGER_ROLE` only: removes the peer ID from whichever cluster holds it, releases `peerIdToCluster`, and emits the existing `PortalRemoved(clusterId, peerId)`. It reads no pool state, so it works for clusters of CLOSED and FAILED pools. It is not `whenNotPaused` (see below). Operators keep `removePortal` for their own cluster.
3. Length caps, enforced on `registerCluster`, `addPortal`, `setPortalMetadata`, `setClusterMetadata` and `setClusterMetadataByPool`: metadata at most `MAX_METADATA_LENGTH = 1024` bytes (`MetadataTooLong`), peer ID at most `MAX_PEER_ID_LENGTH = 128` bytes (`PeerIdTooLong`). Peer IDs in use are 38-byte Ed25519 identity multihashes, and cluster metadata in use is a short JSON object, well under the cap.

### Why admin removal works while paused

`pause()` also blocks `stake` and `unstake`, so every deposit and exit in every pool. If removing a wrong binding needed the registry unpaused, then either fixing a binding during an incident would mean re-opening stake/unstake, or the registry would have to stay unpaused while a wrong binding is live. Removal can't move funds and is held by a role SQD controls, which is how the other admin setters (`setMana`, `setMinStake`, `setFactory`) already behave. `addPortal` keeps `whenNotPaused`, so a pause still freezes new bindings.

### Why removal is keyed by peer ID

Operators can still `removePortal` by index, which swaps the last entry into the removed slot. An index-based admin call could then hit a different portal than intended if the operator acts first. Keying by peer ID removes that race, and the peer ID is what a wrong binding is about.

## Storage Layout Evidence

No state variables added. `PORTAL_MANAGER_ROLE` grants live in OpenZeppelin 5.5.0 AccessControl's namespaced storage; the new values are constants.

`forge inspect PortalRegistry storageLayout` at `b379b86` and on this branch print the same table:

```text
| Name               | Type                                               | Slot | Offset | Bytes |
| SQD                | contract IERC20                                    | 0    | 0      | 20    |
| _clusters          | mapping(bytes32 => struct IPortalRegistry.Cluster) | 1    | 0      | 32    |
| ownerClusters      | mapping(address => bytes32[])                      | 2    | 0      | 32    |
| addressToClusterId | mapping(address => bytes32)                        | 3    | 0      | 32    |
| peerIdToCluster    | mapping(bytes32 => bytes32)                        | 4    | 0      | 32    |
| _isCluster         | mapping(address => bool)                           | 5    | 0      | 32    |
| minStake           | uint256                                            | 6    | 0      | 32    |
| mana               | uint256                                            | 7    | 0      | 32    |
| factory            | address                                            | 8    | 0      | 20    |
| allClusterIds      | mapping(uint256 => bytes32)                        | 9    | 0      | 32    |
| clusterCount       | uint256                                            | 10   | 0      | 32    |
| __gap              | uint256[50]                                        | 11   | 0      | 1600  |
```

`diff` of the two tables: empty. The JSON layouts (`--json`) are equal once the compiler's AST ids in type names (`t_struct(Cluster)4885_storage` vs `…5041_storage`) are normalised; the struct members and their slots match.

Release tooling agrees:

- `pnpm artifacts` leaves `layout/PortalRegistry.json` unchanged. Only `abi/PortalRegistry.json` changes: it gains `PORTAL_MANAGER_ROLE`, `MAX_METADATA_LENGTH`, `MAX_PEER_ID_LENGTH`, `forceRemovePortal` and the three new errors. Nothing is removed.
- `pnpm check:upgrade-safety <checkout of portal-contracts-v1.2.0>` (OpenZeppelin's validator) passes for PortalRegistry, PortalPoolFactory and PortalPoolImplementation: "3 contracts pass; 3 of them compared with the baseline and safe to upgrade from it".

## Identities (read 2026-11-12)

These are the only fixed on-chain facts this plan relies on. Each one is read again before it is used: the script requires the admin to hold `DEFAULT_ADMIN_ROLE` and reads the current implementation from the ERC-1967 slot, and the fork rehearsal skips if the admin changed. No amount, CU or `mana` value is fixed here, because those move.

- Registry implementation: `0xC3725B2584ad46c52F9EFA6f27d0291e3DBC3045`, the rollback target. Its runtime bytecode equals `forge inspect PortalRegistry deployedBytecode` at `b379b86` once the UUPS `__self` immutable (two occurrences) is masked.
- `DEFAULT_ADMIN_ROLE`: only `0x5800eEB867D6c490051321239E15C3ac90e801C1`, the admin vault (an MPC wallet, no contract code on-chain). Checked by replaying every `RoleGranted`/`RoleRevoked` since deployment (block 423,409,277) and with `hasRole` for every past holder.
- Clusters: SQD Revenue Pool `0x438c2a47e82cD445524Ce5651AE7E6c1Dd386D09` and Lambda x SQD `0x89cA93e09ec7355A1d6bd410Fe0bB4C9B24542DB`, both registered through the factory `0x18184740eBE24881355E33cec620C44E575F2C70`.

## Fork Rehearsal

`test/fork/PortalRegistryUpgradeFork.t.sol` runs against the latest Arbitrum One block. CI's "Upgrade safety" job runs it on every pull request.

```
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc forge test --match-contract PortalRegistryUpgradeFork -vv
```

Live state moves, so every check compares with values read earlier in the same run or states a relationship. The test skips, with the reason, when `ARBITRUM_RPC_URL` is unset, when the registry already answers `PORTAL_MANAGER_ROLE()` (the new code is live), or when the admin no longer holds `DEFAULT_ADMIN_ROLE`. What it checks:

1. It reads the implementation slot, `mana`, both clusters, registry slots 0–10, the registry's SQD balance, `minStake`, `clusterCount` and `factory`. Each cluster's CUs equal `min(totalStaked, capacity) × mana / 1e22` for active clusters, and 0 for inactive ones.
2. It deploys the new implementation and calls `upgradeToAndCall(new, 0x)` as the admin. Everything read in step 1 is unchanged, `mana` included, and the CU relationship still holds.
3. `setMana(80)`: `mana` is 80, and each cluster's CUs equal `min(totalStaked, capacity) × 80 / 1e22` from current fork state. Nothing else changes.
4. A staker round trip on the live pool with the most free capacity. The amount is the smallest of 10,000 SQD, that free capacity and the wallet cap; if no pool has room, the round trips are not run.
   - The pool's operator tops up rewards first, if the pool distributes and the top-up's buyback goes through.
   - The deposit raises the cluster's `totalStaked` and the registry's SQD balance by exactly the amount. `requestExit`, waiting until the ticket's unlock time and `withdrawExit` bring both back.
   - `claimRewards` pays exactly what `getClaimableRewards` reported, and more than 0 after a top-up.
5. `grantRole(PORTAL_MANAGER_ROLE, manager)`. The manager binds a fresh 38-byte peer ID to that pool's cluster:
   - `getClusterIdByPeerId` returns the cluster;
   - the portal count rises by one;
   - `getComputationUnits` through the peer lookup matches the step-3 relationship;
   - `getActiveClusters` lists the cluster, with the new portal, exactly when the cluster is active.
6. The operator's `addPortal` reverts with `AccessControlUnauthorizedAccount(operator, PORTAL_MANAGER_ROLE)`.
7. `forceRemovePortal(peerId)` releases the peer ID, and the state matches step 1 again.
8. Rollback: `upgradeToAndCall(<implementation read in step 1>, 0x)`.
   - The state matches step 1.
   - `mana` stays 80 and the role grant stays, because both are storage.
   - A second staker round trip works on the old code.
   - The old code lets the operator call `addPortal` again.

Results: passed against the live chain on 2026-11-12 and 2026-11-13. To check the skip, an anvil fork of Arbitrum One was given the upgrade and `setMana(80)` as the impersonated admin. Against that fork, the test reported `SKIP: the registry already runs the new code; the deploy is recorded in upgrades/` and did not fail.

`script/UpgradePortalRegistry.s.sol` was also dry-run against Arbitrum One (no key, no `--broadcast`), with `PORTAL_MANAGER` unset so the role goes to the vault. It prints each admin call as a contract call for the admin vault. It then simulates the printed calldata as the vault: the upgrade, `setMana(80)`, and `grantRole` to the vault, after which it checks `mana` and `hasRole`. It ends with `simulation ok; cluster 0 CUs before/after: <before> <after>`: the first cluster's CUs read before the simulated upgrade and after the simulated `setMana(80)`.

## Steps

Pausing is not needed: there is no storage migration and the upgrade is a single transaction.

Every admin call (steps 2–4 and the rollback) is signed from the admin vault `0x5800eEB867D6c490051321239E15C3ac90e801C1` as a contract call on Arbitrum One: to the registry proxy `0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850`, value 0, with the calldata the script prints for that step. Sign them one at a time, in order, and let each one confirm before the next.

0. Pre-checks. Run the fork rehearsal on the latest block: it must pass, not skip. Then, just before step 2, read and record these values. The post-upgrade checks compare against them.
   - the implementation slot: `cast storage 0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. It must still be `0xC3725B…3045`, the rollback target;
   - `hasRole(0x00…00, 0x5800…01C1)`, which must be true;
   - `mana()`;
   - for each cluster (`getClusterIdByAddress(pool)`, then `getCluster(id)`): `totalStaked`, `active`, `operator`, `metadata` and the portal count; and the pool's `getPoolInfo().capacity`;
   - `SQD.balanceOf(registry)`, with SQD at `0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`.
1. Deploy the implementation and print the admin calls. This is the only step that is not an admin call: the deploy needs no role, so it is broadcast from a deployer account.
   ```
   forge script script/UpgradePortalRegistry.s.sol \
     --rpc-url https://arb1.arbitrum.io/rpc --broadcast --account <deployer>
   ```
   With `PORTAL_MANAGER` unset, the role goes to the admin vault; set it only to grant the role elsewhere. Verify the implementation on Arbiscan before step 2.
2. Admin vault: script "Step 1", `upgradeToAndCall(<new implementation>, 0x)`. The calldata embeds the new implementation address, so take it from the step-1 output.
3. Admin vault: script "Step 2", `setMana(80)`, calldata `0x0def8b8a0000000000000000000000000000000000000000000000000000000000000050`.
4. Admin vault: script "Step 3", `grantRole(PORTAL_MANAGER_ROLE, 0x5800eEB867D6c490051321239E15C3ac90e801C1)`, calldata `0x2f2ff15d47ce7f42ed0dcf5a065179619cbdec6b114f043d529ee4d28ca1dfc72e825cef0000000000000000000000005800eeb867d6c490051321239e15c3ac90e801c1`. The vault grants the role to itself.

## Post-Upgrade Checks

All checks are relative: each one compares with the pre-check record or states a relationship, read at check time.

- The implementation slot is the new implementation address.
- `PORTAL_MANAGER_ROLE()` = `0x47ce7f42…5cef`, and `hasRole(PORTAL_MANAGER_ROLE, 0x5800…01C1)` is true.
- `MAX_METADATA_LENGTH()` = 1024 and `MAX_PEER_ID_LENGTH()` = 128.
- `mana()` = 80.
- For each active cluster, `getComputationUnits` = `min(totalStaked, capacity) × 80 / 1e22`, using `totalStaked` and `capacity` read at check time. An inactive cluster reports 0.
- Each cluster's `active`, `operator`, `metadata` and portal count equal the pre-check record. `totalStaked` may have moved through deposits and exits in between, and `active` follows it across `minStake`.
- `SQD.balanceOf(registry)` equals the sum of both clusters' `totalStaked`.
- `eth_estimateGas` of `addPortal` from a cluster's operator reverts; from the admin vault it succeeds.

## Release (after the upgrade is deployed)

Per `RELEASING.md`, the release is a separate pull request, opened only after steps 1–4 are live. This pull request does not bump any version.

1. Write the deployment report in `upgrades/`: the deploy and admin transaction hashes, the new implementation address, and the post-upgrade check results.
2. In one release pull request:
   - set `version` to `1.3.0` in `packages/portal-contracts/package.json` and in `deployments/42161.json`;
   - in `deployments/42161.json`, set `contracts.PortalRegistry.implementation` to the new implementation address. The proxy address, `startBlock` and `deployTx` stay the same;
   - in the root `Readme.md` table "Portal Pool system (Arbitrum One)", replace the "↳ Registry implementation" address `0xC3725B…3045` and its Arbiscan link with the new implementation;
   - run `pnpm artifacts` only if the sources changed after this pull request generated `abi/` and `layout/`;
   - delete `test/fork/PortalRegistryUpgradeFork.t.sol` (see the cleanup note below).
3. The live check on that pull request ("Deployments match the chain", `.github/workflows/portal-contracts-live.yml`, the same as `pnpm check:live`) must pass. It builds the pull request's sources and compares them with the chain, the new registry implementation included.
4. Merge, then tag the merge commit and push the tag: `git tag portal-contracts-v1.3.0 <merge commit> && git push origin portal-contracts-v1.3.0`. From then on, the daily live check builds that tag and the upgrade-safety check compares pull requests with it.

Cleanup in the same release pull request: delete `test/fork/PortalRegistryUpgradeFork.t.sol`. Once the upgrade is live the rehearsal has no target (it only skips), and the deploy is recorded in `upgrades/`.

## Rollback

Both calls are signed from the admin vault, to the registry proxy, value 0, in this order. The script prints them as "Rollback 1" and "Rollback 2".

1. `upgradeToAndCall(0xC3725B2584ad46c52F9EFA6f27d0291e3DBC3045, 0x)`, calldata `0x4f1ef286000000000000000000000000c3725b2584ad46c52f9efa6f27d0291e3dbc304500000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000`. Rehearsed: state, stake and exits work after it.
2. `revokeRole(PORTAL_MANAGER_ROLE, 0x5800eEB867D6c490051321239E15C3ac90e801C1)`, calldata `0xd547741f47ce7f42ed0dcf5a065179619cbdec6b114f043d529ee4d28ca1dfc72e825cef0000000000000000000000005800eeb867d6c490051321239e15c3ac90e801c1`. The vault drops its own manager role and keeps `DEFAULT_ADMIN_ROLE`, so it can grant the role again after a fixed upgrade. The grant survives a code rollback because it is storage; the old code does not use it, but it should not stay behind.
3. `mana` stays at 80 after a code rollback. Sign `setMana(<mana from the pre-check record>)` from the vault only if the mana change itself must be undone.

After a rollback, operators can call `addPortal` again, so binding peer IDs is no longer limited to the manager; the length caps are gone, and portals the manager registered stay registered. Do not run a third-party pool on the rolled-back code.
