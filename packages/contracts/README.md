<p align="center">
  <a href="https://sqd.dev/">
    <img src="https://sqd.dev/brand/Logo_bl-bg.svg" height="100px" />
  </a>
</p>

<h1 align="center">SQD Network Smart Contracts</h1>

<p align="center">
  On-chain coordination layer for the <a href="https://sqd.dev/">SQD decentralized data network</a> — workers, stakers, gateways, and rewards.
</p>

---

## What is this?

SQD Network is a decentralized network where **workers** store blockchain data and serve queries. Anyone can earn from the network in three ways:

- **Run a worker** — lock up a bond, serve data, earn rewards.
- **Stake (delegate)** on workers you trust — share in their rewards without running a node.
- **Run a gateway** — lock up SQD to receive *computation units* that let your application query the network.

These contracts are the on-chain rails that make all of the above work: they hold bonds and stakes, track workers and gateways, distribute rewards approved by an oracle committee, and manage vesting for early contributors.


## The contracts, in plain language

### Core protocol

| Contract | What it does |
|---|---|
| [`SQD.sol`](./src/SQD.sol) | The SQD ERC-20 token on Ethereum mainnet. Fixed supply of **1,337,000,000 SQD** minted at deployment. Supports Arbitrum's custom-gateway bridging flow. |
| [`arbitrum/SQD.sol`](./src/arbitrum/SQD.sol) | The L2 side of SQD on Arbitrum. The Arbitrum gateway mints/burns here when users bridge to or from L1. |
| [`Router.sol`](./src/Router.sol) | A single on-chain phone book. Every other contract reads Router to find the current `Staking`, `WorkerRegistration`, `NetworkController`, `RewardTreasury`, and `RewardCalculation`. Admin can swap any of them to upgrade the system. |
| [`NetworkController.sol`](./src/NetworkController.sol) | Stores network-wide settings: epoch length, worker bond amount, lock periods, target storage capacity, and the yearly reward cap. Also keeps an allowlist of contracts that vesting wallets are permitted to call. |

### Workers, stakers, and rewards

| Contract | What it does |
|---|---|
| [`WorkerRegistration.sol`](./src/WorkerRegistration.sol) | Register and manage data-serving workers. Registering locks up the SQD bond; deregistering schedules it for withdrawal after a lock period. Each worker is identified by a libp2p peer ID. |
| [`Staking.sol`](./src/Staking.sol) | Lets anyone delegate SQD to a worker and earn a share of its rewards, using the standard "cumulative reward-per-share" accounting (the same pattern as MasterChef). Deposits are locked for at least one epoch. |
| [`DistributedRewardDistribution.sol`](./src/DistributedRewardDistribution.sol) | Where off-chain oracles push reward batches. A rotating subset of whitelisted oracles proposes a batch, the others approve it, and once quorum is reached the rewards get credited. Batches must cover consecutive block ranges — no gaps, no overlaps. |
| [`RewardTreasury.sol`](./src/RewardTreasury.sol) | Holds the SQD that funds rewards. When a worker or staker claims, the Treasury asks a whitelisted distributor how much they're owed and sends the tokens. |
| [`RewardCalculation.sol`](./src/RewardCalculation.sol) | Read-only. Computes the current APY based on how full the network is (target capacity vs. actual storage), capped so the reward pool can't be drained faster than the yearly limit. Also exposes the gateway "boost factor" for long locks. |
| [`SoftCap.sol`](./src/SoftCap.sol) / [`LinearToSqrtCap.sol`](./src/LinearToSqrtCap.sol) | Two alternative curves that cap a worker's *effective* delegated stake for reward purposes, so a single whale staker can't dominate rewards. |

### Gateways (data consumers)

| Contract | What it does |
|---|---|
| [`GatewayRegistry.sol`](./src/GatewayRegistry.sol) | Register gateways, lock SQD to receive computation units (CUs), and tell workers which gateway is allowed to query how much. A gateway operator can run several gateways ("a cluster") under one stake. Lock durations from one epoch up to three years, with an optional boost the longer you lock. |
| [`gateway-strategies/EqualStrategy.sol`](./src/gateway-strategies/EqualStrategy.sol) | Simple allocation policy: split a gateway's CUs evenly across every active worker. |
| [`gateway-strategies/SubequalStrategy.sol`](./src/gateway-strategies/SubequalStrategy.sol) | Operator picks a specific subset of workers; CUs are split evenly across those. |
| [`AllocationsViewer.sol`](./src/AllocationsViewer.sol) | Convenience read-only contract for UIs and indexers to page through every gateway's allocation to a given worker. |

### Vesting and distribution

| Contract | What it does |
|---|---|
| [`Vesting.sol`](./src/Vesting.sol) | Linear-vesting wallet with a cliff. The beneficiary can *also* call allowlisted protocol contracts (stake, register workers, etc.) through the vesting wallet while tokens are still vesting — vested tokens keep vesting even while they're deployed in the protocol. |
| [`VestingFactory.sol`](./src/VestingFactory.sol) | Deploys `SubsquidVesting` wallets. Only the team (role-gated) can create new ones. |
| [`TemporaryHolding.sol`](./src/TemporaryHolding.sol) | Time-locked SQD that a beneficiary can *use* on-chain before a deadline (to stake, run a gateway, etc.) but cannot withdraw. After the deadline, the admin reclaims whatever's left. |
| [`TemporaryHoldingFactory.sol`](./src/TemporaryHoldingFactory.sol) | Deploys `TemporaryHolding` contracts. Role-gated. |
| [`MerkleDistributor.sol`](./src/MerkleDistributor.sol) | Standard Merkle-proof airdrop contract (same shape as Uniswap's). Owner can reclaim leftovers once the drop is over. |

### Base utilities

| Contract | What it does |
|---|---|
| [`AccessControlledPausable.sol`](./src/AccessControlledPausable.sol) | Abstract base: combines OpenZeppelin's `AccessControl` with a `PAUSER_ROLE`-gated pause switch. |
| [`Executable.sol`](./src/Executable.sol) | Abstract base used by vesting / holding contracts. Lets the beneficiary call arbitrary allowlisted targets while keeping track of how much SQD is currently deployed in the protocol. |

## Directory structure

| Path | Contents |
|---|---|
| `src/` | Solidity sources |
| `deploy/` | Foundry deployment scripts (run with `forge script Deploy.s.sol`) |
| `deployments/` | Deployment artifacts per network |
| `artifacts/` | Compiled contract output |
| `scripts/` | TypeScript utility scripts (register workers, list workers, etc.) |
| `test/` | Foundry tests |

## Install, build, test

These contracts use [Foundry](https://getfoundry.sh/) — install it first.

```bash
pnpm i          # install node dependencies
pnpm build      # compile
pnpm run test   # run the foundry test suite
```

## Deploying

```bash
PRIVATE_KEY=0x.... pnpm run deploy
```

`PRIVATE_KEY` is the deployer's key. The chosen network is picked up from your `.env` — see [Worker registration](#worker-registration) for the relevant variables.

---

## Deployed addresses

### Ethereum Mainnet

| Contract | Address |
|---|---|
| **SQD** | [`0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`](https://etherscan.io/token/0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1) |

### Arbitrum One (production)

| Contract | Address |
|---|---|
| **SQD** | [`0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`](https://arbiscan.io/token/0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1) |
| **Router** | [`0x67F56D27dab93eEb07f6372274aCa277F49dA941`](https://arbiscan.io/address/0x67F56D27dab93eEb07f6372274aCa277F49dA941) |
| **NetworkController** | [`0xf5462EF65Ca8a9Cca789c912Bc8ada80b582d68d`](https://arbiscan.io/address/0xf5462EF65Ca8a9Cca789c912Bc8ada80b582d68d) |
| **Staking** | [`0xb31a0d39d2c69ed4b28d96e12cbf52c5f9ac9a51`](https://arbiscan.io/address/0xb31a0d39d2c69ed4b28d96e12cbf52c5f9ac9a51) |
| **WorkerRegistration** | [`0x36e2b147db67e76ab67a4d07c293670ebefcae4e`](https://arbiscan.io/address/0x36e2b147db67e76ab67a4d07c293670ebefcae4e) |
| **RewardTreasury** | [`0x237abf43bc51fd5c50d0d598a1a4c26e56a8a2a0`](https://arbiscan.io/address/0x237abf43bc51fd5c50d0d598a1a4c26e56a8a2a0) |
| **DistributedRewardsDistribution** | [`0x4de282bD18aE4987B3070F4D5eF8c80756362AEa`](https://arbiscan.io/address/0x4de282bD18aE4987B3070F4D5eF8c80756362AEa) |
| **GatewayRegistry** | [`0x8a90a1ce5fa8cf71de9e6f76b7d3c0b72feb8c4b`](https://arbiscan.io/address/0x8a90a1ce5fa8cf71de9e6f76b7d3c0b72feb8c4b) |
| **RewardCalculation** | [`0xd3D2C185a30484641C07b60e7d952d7B85516eB5`](https://arbiscan.io/address/0xd3D2C185a30484641C07b60e7d952d7B85516eB5) |
| **SoftCap** | [`0xde29d5215c28036ce56091ea91038c94c84c87d0`](https://arbiscan.io/address/0xde29d5215c28036ce56091ea91038c94c84c87d0) |
| **EqualStrategy** | [`0xa604f84c9c59e223b12c831b35723aa0d7277f8b`](https://arbiscan.io/address/0xa604f84c9c59e223b12c831b35723aa0d7277f8b) |
| **SubequalStrategy** | [`0xf197094d96f45325ee8bd2c43c5d25c05d66ab62`](https://arbiscan.io/address/0xf197094d96f45325ee8bd2c43c5d25c05d66ab62) |
| **AllocationsViewer** | [`0x88ce6d8d70df9fe049315fd9d6c3d59108c15c4c`](https://arbiscan.io/address/0x88ce6d8d70df9fe049315fd9d6c3d59108c15c4c) |
| **VestingFactory** | [`0x1f8f83cd76baeca1cb5c064ad59203c82b4e4ece`](https://arbiscan.io/address/0x1f8f83cd76baeca1cb5c064ad59203c82b4e4ece) |
| **TemporaryHoldingFactory** | [`0x14926ebf05a904b8e2e2bf05c10ecca9a54d8d0d`](https://arbiscan.io/address/0x14926ebf05a904b8e2e2bf05c10ecca9a54d8d0d) |

### Arbitrum Sepolia (testnet)

| Contract | Address |
|---|---|
| **tSQDArbitrum** | [`0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c`](https://sepolia.arbiscan.io/token/0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c) |
| **Router** | [`0xD2093610c5d27c201CD47bCF1Df4071610114b64`](https://sepolia.arbiscan.io/address/0xD2093610c5d27c201CD47bCF1Df4071610114b64) |
| **NetworkController** | [`0x68Fc7E375945d8C8dFb0050c337Ff09E962D976D`](https://sepolia.arbiscan.io/address/0x68Fc7E375945d8C8dFb0050c337Ff09E962D976D) |
| **Staking** | [`0x347E326b8b4EA27c87d5CA291e708cdEC6d65EB5`](https://sepolia.arbiscan.io/address/0x347E326b8b4EA27c87d5CA291e708cdEC6d65EB5) |
| **WorkerRegistration** | [`0xCD8e983F8c4202B0085825Cf21833927D1e2b6Dc`](https://sepolia.arbiscan.io/address/0xCD8e983F8c4202B0085825Cf21833927D1e2b6Dc) |
| **RewardTreasury** | [`0x785136e611E15D532C36502AaBdfE8E35008c7ca`](https://sepolia.arbiscan.io/address/0x785136e611E15D532C36502AaBdfE8E35008c7ca) |
| **DistributedRewardsDistribution** | [`0x68f9fE3504652360afF430dF198E1Cb7B2dCfD57`](https://sepolia.arbiscan.io/address/0x68f9fE3504652360afF430dF198E1Cb7B2dCfD57) |
| **GatewayRegistry** | [`0xAB46F688AbA4FcD1920F21E9BD16B229316D8b0a`](https://sepolia.arbiscan.io/address/0xAB46F688AbA4FcD1920F21E9BD16B229316D8b0a) |
| **VestingFactory** | [`0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca`](https://sepolia.arbiscan.io/address/0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca) |
| **RewardCalculation** | [`0x93D16d5210122c804DE9931b41b3c6FA2649CE3F`](https://sepolia.arbiscan.io/address/0x93D16d5210122c804DE9931b41b3c6FA2649CE3F) |
| **EqualStrategy** | [`0x94DF0410BF415765e8e9431d545AF9805859b5Db`](https://sepolia.arbiscan.io/address/0x94DF0410BF415765e8e9431d545AF9805859b5Db) |
| **SubequalStrategy** | [`0x20cA692986D127CE78938E2518cE2F49F105eC48`](https://sepolia.arbiscan.io/address/0x20cA692986D127CE78938E2518cE2F49F105eC48) |
| **AllocationsViewer** | [`0xC0Af6432947db51e0C179050dAF801F19d40D2B7`](https://sepolia.arbiscan.io/address/0xC0Af6432947db51e0C179050dAF801F19d40D2B7) |

### Arbitrum Goerli (legacy)

| Contract | Address |
|---|---|
| tSQD | [`0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9`](https://goerli.arbiscan.io/address/0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9) |
| DistributedRewardsDistribution | [`0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9`](https://goerli.arbiscan.io/address/0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9) |
| RewardTreasury | [`0x87F1B67c10237CBB32019EF33052B96940994149`](https://goerli.arbiscan.io/address/0x87F1B67c10237CBB32019EF33052B96940994149) |
| Staking | [`0x99Fa79f673ffa4354e96670999cb67A0d43de4C1`](https://goerli.arbiscan.io/address/0x99Fa79f673ffa4354e96670999cb67A0d43de4C1) |
| WorkerRegistration | [`0x6867E96A0259E68A571a368C0b8d733Aa56E3915`](https://goerli.arbiscan.io/address/0x6867E96A0259E68A571a368C0b8d733Aa56E3915) |
| RewardCalculation | [`0xC60CA978Bf5A9E2374B82D346d1B36Fd35D27991`](https://goerli.arbiscan.io/address/0xC60CA978Bf5A9E2374B82D346d1B36Fd35D27991) |
| NetworkController | [`0xF0512AD4f8945Ba47B9100609122B4B2769cA99C`](https://goerli.arbiscan.io/address/0xF0512AD4f8945Ba47B9100609122B4B2769cA99C) |

---

## Worker registration

Before running the script, check the variables in `.env`:

```
# RPC URL (defaults to 127.0.0.1:8545 if not set)
RPC_PROVIDER_URL=
# One of the networks listed in /deployments (defaults to localhost)
NETWORK_NAME=
```

Register a worker with:

```bash
pnpm run register-worker [base58PeerID] [privateKey]
```

The account must hold **100,000 tSQD** for the bond plus some native gas token.

Example:

```bash
pnpm run register-worker QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

## Listing active workers

Same `.env` variables as above. Then:

```bash
pnpm run list-workers
```

---

<p align="center">
  Built with ❤️ by <a href="https://sqd.dev/">SQD Network</a>
</p>
