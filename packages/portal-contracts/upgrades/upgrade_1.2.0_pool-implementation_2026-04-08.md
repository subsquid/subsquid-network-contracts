# Pool implementation upgrade of 2026-04-08 (after 1.2.0)

This record was written in November 2026 from chain data. No report was written at the time of the upgrade, and `broadcast/` has no file for it.

Two days after the 1.2.0 upgrade ([upgrade_1.1.0_1.2.0.md](upgrade_1.1.0_1.2.0.md)), the beacon was pointed at a new pool implementation. The factory and the registry were not changed.

## What changed

`topUpRewards` can be called while a pool is still collecting deposits. Before, it reverted with `InvalidState` unless the pool was active or idle.

Source: commit `9438b7f` ("feat: allow top-up rewards in COLLECTING state"). It changes one condition in `src/PortalPoolImplementation.sol` and nothing else under `src/`. Storage layout is unchanged.

## Network

- chain: Arbitrum One
- chain id: `42161`
- sender: `0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee` (the admin signer of the earlier upgrades)

## Upgraded contract

- beacon: `0x16983f5a5816d4B04c92Ab43Fed3B2F212D4e568`
- previous pool implementation (1.2.0): `0x09331e886d1D65F467ebBa1E1e88CE4745DEF677`
- new pool implementation: `0x2981E64342fc76d531168Cf6754F81422138b3C4`

## Transaction

- `upgradeBeacon(address)` on the factory `0x18184740eBE24881355E33cec620C44E575F2C70`:
  - `0xa3d4f37a64f626beb58d77192d072e07a1e26a733b1eab3b77a26db080661093`
  - block `450354439`, 2026-04-08 13:52:49 UTC

The transaction that deployed the new implementation is not recorded here.

## How this was established

- The beacon emitted `Upgraded(address)` four times since its deployment. This is the fourth and last one.

  | Block | Time (UTC) | New implementation | Upgrade |
  |---|---|---|---|
  | 423409325 | 2026-01-20 17:08:40 | `0xDaE912adE17942Ad605c093c0454f86A3C077976` | deployment |
  | 440813517 | 2026-03-11 22:44:51 | `0x07dD4772462F20e022c0db245805483CeaAda2FF` | 1.0.0 to 1.1.0 |
  | 449666820 | 2026-04-06 14:12:09 | `0x09331e886d1D65F467ebBa1E1e88CE4745DEF677` | 1.1.0 to 1.2.0 |
  | 450354439 | 2026-04-08 13:52:49 | `0x2981E64342fc76d531168Cf6754F81422138b3C4` | this one |

- The runtime code at `0x09331e88…` equals a forge 1.5.1 build of `PortalPoolImplementation` at commit `6a1ef02`, which does not have the change.
- The runtime code at `0x2981E643…` equals a build at commit `9438b7f`, and a build of this package at version 1.2.0.
