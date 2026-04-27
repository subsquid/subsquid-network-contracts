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
