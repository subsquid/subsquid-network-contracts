# Live Arbitrum Upgrade Success Report

Date: 2026-04-05

## Status

The live Arbitrum upgrade completed successfully.

## Network

- chain: Arbitrum One
- chain id: `42161`
- admin signer: `0xFa27FdC303FA02F6F21Ec8F597421b7B34BD61Ee`

## Upgraded Contracts

- factory proxy: `0x18184740eBE24881355E33cec620C44e575f2C70`
- registry proxy: `0x29eDe9eb0AD3C02b6a98B0E41bF99Cd709812850`
- beacon: `0x16983f5a5816D4B04C92Ab43fED3b2f212d4e568`

## New Implementations

- factory implementation: `0xcE5D796769Ba065Bf61a8Efc892a8a835FAe0351`
- pool implementation: `0x09331e886d1D65F467ebBa1E1e88CE4745DEF677`
- registry implementation: `0xC3725B2584ad46c52F9EFA6f27d0291e3DBC3045`

## Transaction Hashes

- deploy factory implementation:
  - `0xe9b649795519d2228c029257dc54ce79b3d9dbc54882f911095bf97222eb7c9b`
- deploy pool implementation:
  - `0xa65d881d14428fd12f3778ebd4fd2fb9e4bf63a8e7372f66c1c53357a00a4996`
- deploy registry implementation:
  - `0x0f6d82c6d0534a896cfc722da5436689c4be0213ea08a061416244f16d368f5c`
- pause pool0:
  - `0xe0abdcb7f69d549e688d4ab6339a6865e71f55384f72beed10d9088b5faa1bde`
- pause pool1:
  - `0x0f5908cb513e60431ddb4ef9ec8995c35b0a3d62be45997756cd3648af056829`
- pause factory:
  - `0xa4b0e108c5ade8408b2b09f974b3a3d0fbbc034b34b967df1ffb5e854d0a1e21`
- pause registry:
  - `0x02a2e2288dbd3a1a28f89845578270ae82d6cc1f479213e71ab52415b73dfd79`
- upgrade factory proxy:
  - `0x882749850327e14cc5fde57d3d548e04939eea80dade5fd4593bd472d72d97c5`
- upgrade beacon:
  - `0x0aaf156e223a65ea6d63ba1fe0dda2ba74a0bdc3c97c3f2e479fc0a3f46b4a27`
- upgrade registry proxy:
  - `0x0f26175d522667a9f22201ec533b7a412994fce21920b069b8722613f6b0bdcd`
- set registry min stake:
  - `0x52d9cf8d316b840078b1f311ddb7dc6610eb217e10ee8ce45177ede81b3aa9bb`
- set factory min stake threshold:
  - `0x5b138b1d62594ed4d239b880052b55503bb383af941137491f84945a8903412c`
- unpause registry:
  - `0xba579819c535d4c3b241d24a04fa62caa05277ae379cd9b1fe27631fce214481`
- unpause factory:
  - `0x25371dfecd13b6325393e6cd69e7e482e8f382d7228a83ae069530d095029c67`
- unpause pool0:
  - `0x1f4f448bff9d3a87fc6454126f82534d03b060f0faa84f5be7e31983e42ef53c`
- unpause pool1:
  - `0xfbc15f9a84e65d9674a39d9e07f1aefa9e571ca7f51991055205cfd67038f6c8`

## Block-Pinned Storage Dumps

The public Arbitrum RPC is not archive-capable, so the exact pre/post memory dumps were rebuilt from an archive-capable public RPC:

- archive RPC: `https://arbitrum-one-rpc.publicnode.com`
- pre-upgrade snapshot block: `449666724`
- post-upgrade snapshot block: `449666903`


## Verified Storage Diff

Expected and observed diff:
- `pool0.getComputationUnits`: `25_920_000_000 -> 120_000`
- factory low slots:
  - only `slot 4` changed
- registry low slots:
  - only `slot 6` changed
- existing pool low slots:
  - no diff
- pointer slots changed:
  - factory implementation
  - registry implementation
  - beacon implementation

## Live Post-State Verification

Verified on live Arbitrum:

- `factory.paused() = false`
- `registry.paused() = false`
- `pool0.paused() = false`
- `pool1.paused() = false`
- `pool0.getComputationUnits() = 120000`
- `pool1.getComputationUnits() = 0`
- `pool0.getState() = ACTIVE`
- `pool1.getState() = COLLECTING`
- `factory.portalCount() = 2`
- `registry.clusterCount() = 2`
- `factory.allPortals(0)` unchanged:
  - `0x438c2a47e82cD445524Ce5651AE7E6c1Dd386D09`
- `factory.allPortals(1)` unchanged:
  - `0x89cA93e09ec7355A1d6bd410Fe0bB4C9B24542DB`

## Legacy Compatibility Callability

Read compatibility:

- `factory.minStakeThreshold()` callable
- `pool0.getMinCapacity()` callable
- `pool1.getMinCapacity()` callable

Admin write-path compatibility was checked without mutating state by `eth_estimateGas`:

- `factory.setMinStakeThreshold(100_000 ether)` estimate succeeded
  - gas estimate: `35151`
- `registry.setMinStake(100_000 ether)` estimate succeeded
  - gas estimate: `34521`

## Arbiscan Verification

All three new implementation contracts are verified on Arbiscan:

- factory:
  - address: `0xcE5D796769Ba065Bf61a8Efc892a8a835FAe0351`
  - URL: `https://arbiscan.io/address/0xce5d796769ba065bf61a8efc892a8a835fae0351`
  - GUID: `s7e4qwwus7qplkpvxcluqqrlgsjznvgxi8jedgk7upihg4gmi5`
- pool:
  - address: `0x09331e886d1D65F467ebBa1E1e88CE4745DEF677`
  - URL: `https://arbiscan.io/address/0x09331e886d1d65f467ebba1e1e88ce4745def677`
  - GUID: `caxlichsmpdw7xrtxdcaigse11786dbygii61xq7xkumwxiksn`
- registry:
  - address: `0xC3725B2584ad46c52F9EFA6f27d0291e3DBC3045`
  - URL: `https://arbiscan.io/address/0xc3725b2584ad46c52f9efa6f27d0291e3dbc3045`
  - GUID: `2wltaymsxbi3erildagwrzgszfqvknptfwb3ssieasrxmjpcmx`

## Conclusion

The live Arbitrum upgrade completed successfully and verified cleanly.

- Pause -> upgrade -> threshold update -> unpause sequence succeeded.
- Storage stayed stable except for the expected threshold slots and implementation pointers.
- Existing pool storage remained unchanged.
- Legacy compatibility reads remain callable.
- New implementations are explorer-verified on Arbiscan.
