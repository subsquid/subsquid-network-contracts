# SQD Portal Pool Contracts

Smart contracts for SQD Portal Pools - a revenue-sharing system where SQD holders lock tokens to support network capacity and earn stablecoin rewards.

## How It Works

Portal Pools connect pool operators with SQD holders. Operators create pools and fund them with reward tokens (USDC or USDT). SQD holders deposit their tokens into pools and earn a share of those rewards over time.

### Creating a Pool

Any operator can deploy their own pool through the PortalPoolFactory. When creating a pool, the operator sets a capacity (how much SQD the pool can hold) and a distribution rate (how fast rewards flow to depositors). The operator can also seed the pool with an initial credit of reward tokens.

The initial credit must cover at least one day of distributions at the chosen rate. This ensures the pool doesn't start empty. For example, if you set a rate that distributes 100 USDC per day, your initial credit needs to be at least 100 USDC.

Once created, the pool enters a collecting phase. It stays in this phase until deposits reach the full capacity. If the capacity isn't reached before the deadline (default 30 days), the pool fails and everyone gets their SQD back.

### Distribution Rate

The distribution rate controls how many reward tokens get distributed per second across all depositors. As an operator, you choose this rate based on how much yield you want to offer.

Setting the rate to zero is allowed. This lets you create private pools where no rewards are distributed - useful for sharing capacity with friends or team members without the overhead of managing reward distributions.

When the rate is non-zero, rewards drain from the pool's credit balance over time. You can check the runway (how long until credit runs out) and top up with more reward tokens before it hits zero. 

When the pool runs out of credit, it can go into debt. Top-ups first pay down debt, then increase credit. Because of this, runway and claimable rewards can recover in a non-linear way after dry periods, and the balance can be negative during those periods.

The runway tells you how long rewards will last at the current rate. While there's credit, you earn at the displayed rate.

When the operator tops up a pool that has debt:

1. New funds first pay off the debt (what the pool "owed")
2. Remaining funds become new credit
3. Distribution resumes at the set rate

### Depositing and Earning

Users deposit SQD into a pool and receive plSQD tokens as a receipt. These liquid tokens represent their share of the pool and can be transferred to other wallets. Rewards accumulate automatically based on each user's share - claim them whenever you want.

The pool tracks a credit/debt model internally. When there's credit available, rewards distribute at the set rate. When credit hits zero, no new rewards accumulate but existing unclaimed rewards stay safe. If the operator tops up while the pool has debt, the new funds first pay off what was owed before becoming fresh credit.

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

## Fee Routing

Fees are split by a FeeRouter module. Today, the default configuration routes 100% to providers, but this can be adjusted over time. The FeeRouter is a separate module that can be swapped by the factory admin, allowing the split logic to evolve without changing pool implementations.

## Pool States

Pools move through several states during their lifecycle:

**Collecting** - Initial state after creation. Accepts deposits until capacity is reached or deadline passes.

**Active** - Pool reached capacity and is distributing rewards. Users can deposit more (up to capacity), claim rewards, and request exits.

**Idle** - Active stake dropped below the minimum threshold. Distributions pause until more SQD comes in.

**Failed** - Deadline passed without reaching capacity. Users withdraw their SQD directly.

**Closed** - Users can withdraw immediately without going through the exit queue.

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
- Operator has set a deadline for activation

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
- → **IDLE**: If active stake drops below `minStakeThreshold`

**Note:** Once activated, a pool stays activated. It can go IDLE but never back to COLLECTING.

### IDLE (Temporary Pause)

A pool enters **IDLE** state when the active stake drops too low.

**What's happening:**
- Pool was once active but stake dropped below minimum
- Reward distribution pauses (rate = 0)
- Deposits still accepted
- Exit queue still processes

**What you can do:**
- Deposit SQD to help reactivate
- Complete pending exits
- Claim any rewards earned before IDLE

## Quick Reference

| Concept | What It Means |
|---------|---------------|
| Credit | Reward funds available for distribution |
| Debt | Unfunded obligations (pool ran dry) |
| Runway | How long credit lasts at current rate |
| Distribution rate | Rewards per second to all lockers |
| Exit queue | Line of withdrawal requests waiting |
| plSQD | Your receipt token for deposited SQD |

## Deploy

Testnet (Arbitrum Sepolia):
`forge script script/Deploy.s.sol:DeployPortalSystem --rpc-url https://sepolia-rollup.arbitrum.io/rpc --broadcast --verify`

Mainnet (Arbitrum One):
`forge script script/Deploy.s.sol:DeployArbitrum --rpc-url https://arb1.arbitrum.io/rpc --broadcast --verify`

## Contract Size Optimization

The PortalPoolImplementation contract is close to the 24,576 byte EVM limit. We use `optimizer_runs = 1` to minimize bytecode size. Higher values optimize for cheaper runtime gas but produce larger bytecode.

| optimizer_runs | Contract Size | Margin  | Status |
|----------------|---------------|---------|--------|
| 1              | 24,197 bytes  | +379    | ✓      |
| 100            | 24,231 bytes  | +345    | ✓      |
| 200            | 24,421 bytes  | +155    | ✓      |
| 300            | 24,355 bytes  | +221    | ✓      |
| 400            | 24,378 bytes  | +198    | ✓      |
| 500            | 24,454 bytes  | +122    | ✓      |
| 1000           | 26,694 bytes  | -2,118  | ✗      |
| 2000           | 27,855 bytes  | -3,279  | ✗      |
| 5000           | 29,028 bytes  | -4,452  | ✗      |
| 10000          | 29,755 bytes  | -5,179  | ✗      |

At `optimizer_runs >= 1000`, the contract exceeds the EVM limit and cannot be deployed. The sweet spot is `optimizer_runs = 1` which gives the most margin for future changes while staying deployable.

## License

MIT
