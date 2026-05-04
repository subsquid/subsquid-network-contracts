# SQD Portal Pool Contracts

Smart contracts for SQD Portal Pools - a revenue-sharing system where SQD holders lock tokens to support network capacity and earn stablecoin rewards.

## How It Works

Portal Pools connect pool operators with SQD holders. Operators create pools and fund them with reward tokens (USDC or USDT). SQD holders deposit their tokens into pools and earn a share of those rewards over time.

### Creating a Pool

Pools are deployed through the PortalPoolFactory. By default, deployment is controlled by accounts with `POOL_DEPLOYER_ROLE`. The admin can open deployment with `poolDeploymentOpen`; when deployment is open, an operator can create their own pool directly, while trusted deployers can still create pools on behalf of others.

When creating a pool, the operator sets a capacity (how much SQD the pool can hold), a reward token, and a distribution rate (how fast rewards flow to depositors). The reward token must be allowed by the factory, and capacity must be at least `PortalRegistry.minStake()`.

The initial reward deposit must cover at least one day of distributions at the chosen rate. This check happens before fee routing, so the actual provider credit is whatever provider share remains after the current FeeRouter split. For example, if you set a rate that distributes 100 USDC per day and the fee split sends 100% to providers, your initial deposit needs to be at least 100 USDC.

Once created, the pool enters a collecting phase. It stays in this phase until deposits reach the full capacity. If the capacity isn't reached before the deadline (default 30 days), the pool fails and everyone gets their SQD back.

### Distribution Rate

The distribution rate controls how many reward tokens get distributed per second across all depositors. As an operator, you choose this rate based on how much yield you want to offer.

Setting the rate to zero is allowed. This lets you create private pools where no rewards are distributed - useful for sharing capacity with friends or team members without the overhead of managing reward distributions.

When the rate is non-zero, rewards drain from the pool's credit balance over time. You can check the runway (the timestamp when credit runs out) and top up with more reward tokens before it hits zero.

When the pool runs out of credit, it becomes dry. Rewards stop accruing at the runway timestamp, existing unclaimed rewards stay safe, and the reported debt stays zero. The pool balance does not go negative.

When the operator tops up after a dry period, the provider share becomes new credit and distribution resumes from the top-up time. Dry time is not paid retroactively.

The runway tells you when rewards will stop at the current rate. While there's credit, active stake earns at the displayed rate.

### Depositing and Earning

Users deposit SQD into a pool and receive plSQD tokens as a receipt. These liquid tokens represent their share of the pool and can be transferred to other wallets. Rewards accumulate automatically based on each user's share - claim them whenever you want.

The pool tracks credit and runway internally. When there's credit available, rewards distribute at the set rate. When credit hits zero, no new rewards accumulate but existing unclaimed rewards stay safe. `getDebt()` and the `currentDebt` field in `getRewardStatus()` are kept for compatibility and return zero.

Stakes are divided into active stake and total stake.
While exits are pending, totalStaked can exceed capacity, and new deposits are allowed as long as active stake stays within capacity.
When a user requests an exit, their stake moves out of active stake, stops earning new rewards, and frees capacity so new participants can stake while exits are processed.

### Exiting the Pool

Withdrawals go through an exit queue to prevent bank runs. When you request an exit, you get a ticket and join the queue. The queue processes at a fixed rate (SQD per second), so everyone waits their turn. Once your position clears, you can withdraw your SQD.

This mechanism ensures fair exits regardless of timing. Early exiters don't get an advantage over later ones.


### Whitelist

Operators can enable a whitelist to restrict who can deposit. When enabled, only addresses the operator has approved can participate. This is useful for private pools, team allocations, or any situation where you want to control membership.


## Architecture

The system uses a beacon proxy pattern. All pools share the same implementation contract through a beacon. Upgrading the beacon upgrades every pool at once. The factory and registry use UUPS proxies for their own upgradeability.

```
PortalPoolFactory (UUPS)
    │
    └── creates pools via PortalPoolBeacon
            │
            └── points to PortalPoolImplementation
                    │
                    └── stakes SQD to PortalRegistry (UUPS)
```

## Fee Routing and Buyback

When an operator tops up a pool with reward tokens (USDC, USDT, etc.), the funds pass through a FeeRouter. Depending on the active config, the router can split them three ways:

- **Providers** — stays as stablecoins in the pool, building credit for depositor rewards
- **Worker pool** — converted to SQD and sent to the network's worker reward pool
- **Burn** — converted to SQD and sent to a dead address, permanently removed from supply

The default split is `10000 / 0 / 0`, which means 100% providers, 0% workers, and 0% burn. The admin can change these numbers at any time. For example, `setFeeConfig(5000, 4500, 500)` sets 50% providers / 45% workers / 5% burn. The three numbers must always add up to 10000 (100%).

### How the Buyback Works

In FeeRouterModuleV2, the worker and burn portions are converted from stablecoins to SQD. This happens through an automatic buyback system built into the router.

When the pool routes fees, the non-provider share flows to the FeeRouter contract and the buyback runs immediately in the same transaction. The stablecoins are swapped to SQD through PancakeSwap V3. The purchased SQD is then split proportionally between the worker pool and burn based on the fee config ratios.

For example, with a 50/45/5 split and a $1000 top-up:

1. $500 stays as USDC → providers (pool credit)
2. $500 goes to the FeeRouter and is routed through the buyback
3. it is swapped to SQD via PancakeSwap
4. Of the SQD received: 90% (45/50) goes to the worker reward pool, 10% (5/50) gets burned

If the reward token is already SQD (not a stablecoin), the router skips the swap entirely and just splits the SQD directly between workers and burn.

### Slippage Protection

Swapping on a DEX carries the risk of getting a bad price, especially from MEV sandwich attacks. The router protects against this using a TWAP (time-weighted average price) oracle from PancakeSwap V3. Before executing a swap, it checks what the average price has been over the configured window and sets a minimum acceptable SQD output. If the swap cannot meet that minimum, it reverts instead of executing at a bad rate.

The admin controls slippage protection with `configureSlippageProtection`, `setTwapWindow`, and `setMaxSlippageBPS`. The minimum TWAP window is 600 seconds. The maximum allowed slippage is capped at 5000 bps. Operators do not pass a slippage setting when topping up rewards.

Integrations can call `isSlippageProtectionReady(rewardToken)` before a top-up to see whether the buyback path is ready. Direct token balances held by the router can be swept through the same buyback path with `executeBuyback(rewardToken)`.


## Pool States

Pools move through several states during their lifecycle:

**Collecting** - Initial state after creation. Accepts deposits until capacity is reached or deadline passes.

**Active** - Pool reached capacity and is distributing rewards. Users can deposit more (up to capacity), claim rewards, and request exits.

**Idle** - Registry stake dropped below `PortalRegistry.minStake()`. Distributions pause until more SQD comes in.

**Failed** - Deadline passed without reaching capacity. Users withdraw their SQD directly, and the operator can recover remaining reward tokens.

**Closed** - Factory admin closed the pool. Users withdraw immediately without going through the exit queue, and can claim any rewards that were earned before closure.

### State Overview

```
                    ┌─────────────┐
                    │  COLLECTING │ ← Pool created, accepting deposits
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │  ACTIVE  │◄──►│   IDLE   │    │  FAILED  │
    └────┬─────┘    └──────────┘    └──────────┘
         │          (stake below      (deadline passed
         ▼           minimum)          without activation)
    ┌──────────┐
    │  CLOSED  │ 
    └──────────┘
```

### COLLECTING (Initial State)

When a pool is first created, it starts in **COLLECTING** state.

**What's happening:**
- Pool is open for deposits
- Deposits accumulate until capacity is reached
- No rewards distributed yet
- Operator can top up rewards, but those rewards do not accrue until activation
- Factory has set a deadline for activation

**What you can do:**
- Deposit SQD into the pool
- See total deposits and capacity
- Wait for pool to activate

**Transitions:**
- → **ACTIVE**: When `totalStaked >= capacity`
- → **FAILED**: When deadline passes without reaching capacity

**Duration:** Set by `collectionDeadlineSeconds` (default: 30 days)

### ACTIVE (Healthy State)

A pool becomes **ACTIVE** when it reaches full capacity during the collection period.

**What's happening:**
- All SQD is staked to the Subsquid network
- Rewards drain from credit at the set rate
- Users can deposit more (up to capacity)
- Users can request exits

**What you can do:**
- Deposit more SQD (if below capacity)
- Claim accumulated rewards
- Request exit to start withdrawing

**Transitions:**
- → **IDLE**: If registry stake drops below `PortalRegistry.minStake()`
- → **CLOSED**: If the factory admin closes the pool

**Note:** Once activated, a pool stays activated. It can go IDLE but never back to COLLECTING.

### IDLE (Temporary Pause)

A pool enters **IDLE** state when it was active before, but registry stake drops below `PortalRegistry.minStake()`.

**What's happening:**
- Pool was once active but stake dropped below minimum
- Reward distribution pauses
- Deposits still accepted
- Exit queue still processes

**What you can do:**
- Deposit SQD to help reactivate
- Complete pending exits
- Claim any rewards earned before IDLE

**Transitions:**
- → **ACTIVE**: When stake reaches `PortalRegistry.minStake()` again
- → **CLOSED**: If the factory admin closes the pool

### FAILED (Collection Failed)

A pool becomes **FAILED** when the collection deadline passes before it reaches capacity.

**What's happening:**
- Pool never activated
- Deposits stop
- SQD stays in the pool instead of being staked to the registry
- Operator can recover remaining reward tokens

**What you can do:**
- Withdraw your SQD directly with `withdrawFromFailed`

### CLOSED (Emergency Shutdown)

A factory admin can close a pool in an emergency.

**What's happening:**
- Reward distribution stops
- Exit queue is bypassed
- Users can withdraw their stake immediately
- Rewards earned before closure can still be claimed

**What you can do:**
- Withdraw SQD with `emergencyWithdraw`
- Claim earned rewards with `claimRewardsFromClosed`
- Operator can recover unused reward budget

## Quick Reference

| Concept | What It Means |
|---------|---------------|
| Credit | Reward funds available for distribution |
| Dry state | Pool has no credit left and rewards stop accruing |
| Runway | Timestamp when credit runs out at current rate |
| Distribution rate | Rewards per second to all lockers |
| Exit queue | Line of withdrawal requests waiting |
| plSQD | Your receipt token for deposited SQD |
| Fee split | How top-ups are divided (providers / workers / burn) |
| Auto-buyback | Protocol share is swapped to SQD immediately in FeeRouterModuleV2 |
| TWAP | Time-weighted average price used for slippage protection |
| Min stake | `PortalRegistry.minStake()`, the registry threshold used by pools |

## Deploy

Testnet (Arbitrum Sepolia):
`forge script script/Deploy.s.sol:DeployPortalSystem --rpc-url https://sepolia-rollup.arbitrum.io/rpc --broadcast --verify`

Mainnet (Arbitrum One):
`forge script script/Deploy.s.sol:DeployArbitrum --rpc-url https://arb1.arbitrum.io/rpc --broadcast --verify`

The Sepolia deploy path uses `FeeRouterModuleV2` and currently configures fees as 100% providers until SQD liquidity exists on PancakeSwap V3. The mainnet deploy script still deploys the legacy `FeeRouterModule`; FeeRouterModuleV2 can be deployed separately with `script/DeployFeeRouterV2.s.sol`.

## Contract Size Optimization

The PortalPoolImplementation contract is close to the 24,576 byte EVM limit. We use `optimizer_runs = 1` to minimize bytecode size. Higher values optimize for cheaper runtime gas but produce larger bytecode, so size needs to be checked before changing the optimizer profile.

Current `forge build --sizes` result:

| Contract | Runtime Size | Runtime Margin | Status |
|----------|--------------|----------------|--------|
| PortalPoolImplementation | 23,946 bytes | +630 bytes | ✓ |

The current default profile stays deployable, but the margin is small enough that new pool logic should always be checked with `forge build --sizes`.

## License

MIT
