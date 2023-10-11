# Rewards simulator

This package contains a simulator for the rewards system. It will be used to calculate and distribute rewards on Panthalasa testnet.

## Running

To run reward simulation, run
    
```bash
PRIVATE_KEY=0x... CLICKHOUSE_PASSWORD=... pnpm start {number of workers for this process}
```

## Rewards

The network rewards are paid out to workers and delegators for each epoch. The Reward Manager submits an on-chain claim commitment, from which each participant can claim.

The rewards are allocated from the rewards pool. Each epoch, the rewards pool unlocks `APY_D * S * EPOCH_LENGTH` in rewards, where `EPOCH_LENGTH` is the length of the epoch in days, `S` is the total (bonded + delegated) amount of staked `SQD` during the epoch and `APY_D` is the (variable) base reward rate calculated for the epoch.

### Rewards pool

The `SQD` supply is fixed for the initial, and the rewards are distributed are from a pool, to which `10%` of the supply is allocated at TGE. The reward pool has a protective mechanism, called health factor, which halves the effective rewards rate if the reward pool supply drops below 6-month average reward.

After the initial bootstrapping phase a governance should decide on the target inflation rate to replenish the rewards pool with freshly minted tokens based on the already distributed rewards and participation rate.

### Reward rate

The reward rate depends on the two factors: how much the network is utilized and how much of the supply is staked. The network utilization rate is defined as

```
u_rate = (target_capacity - actual_capacity)/target_capacity
```

The target capacity is calculated as
```
target_capacity = sum([d.reserved_space * d.replication_factor]) 
```
where the sum is over the non-disabled datasets `d`.

The actual capacity is calculated as
```
actual_capacity = num_of_active_workers() * WORKER_CAPCITY * CHURN
```

The `WORKER_CAPACITY` is a fixed storage per worker, set to `1Tb`. `CHURN` is a discounting factor to account for the churn, set to `0.9`.

The target APR (365-day-based rate) is then calculated as:
```
rAPR = base_apr(u_rate) * D(stake_factor)
```
The `base_apr` is set to `20%` in the balances state and is increased up to `70%` to incentivize more workers to join if the target capacity exceeds the actual one (and decreased otherwise):
`rAPR` is gathered from the [RewardCalculator](../contracts/src/RewardCalculation.sol) contract
![image](https://user-images.githubusercontent.com/8627422/256611463-eca7ae21-e26a-47ce-b78d-c1c8d8383205.png)

The discount factor `D` lowers the final `APY` if more than `25%` of the supply is staked:
![image](https://user-images.githubusercontent.com/8627422/256610465-386a8cbc-a57d-4575-bbbc-23eff7b8452e.png)

### Worker reward rate

Each epoch, `rAPR` is calculated and the total of

```
R = rAPR/365 * total_staked * EPOCH_LENGTH
``` 

is unlocked from the rewards pool.

The rewards are then distributed between the workers and delegators, and the leftovers are split between the burn and the treasury.

For a single worker and stakers for this token, the maximal reward is `rAPR/365 * (bond + staked) * EPOCH_LENGTH`. It is split into the worker liveness reward and the worker traffic reward.

Let `S[i]` be the stake for `i`-th worker and `T[i]` be the traffic units (defined below) processed by the worker. We define the relative weights as

```
s[i] = S[i]/sum(S[i])
t_scanned[i] = T_scanned[i]/sum(T_scanned[i])
t_e[i] = T_e[i]/sum(T_e[i])
t[i] = sqrt(t_scanned[i] * t_e[i])
```

In words, `s[i]` and `t[i]` correspond to the contribution of the `i`-th worker to the total stake and to total traffic, respectively.

The traffic weight `t[i]` is a geometric average of the normalized scanned (`t_scanned[i]`)  and the egress (`t_e[i]`) traffic processed by the worker. It is calculated by aggregating the logs of the queries processed by the worker during the epoch, and for each processed query the worker reports the response size (egress) and the number of scanned data chunks.

The max potential yield for the epoch is given by `rAPR` discribed above:

```
r_max = rAPR/365 * EPOCH_LENGTH
```

The actuall yield `r[i]` for the `i`-th worker is discounted:

```
r[i] = r_max * D_liveness * D_traffic(t_i, s_i) * D_tenure
```

`D_traffic` is a Cobb-Douglas type discount factor defined as

```
D_traffic(t_i, s_i) = min( (t_i/s_i)^alpha, 1 )
```

with the elasticity parameter alpha set to `0.1`.

It has the following properties:

- Always in the interval `[0, 1]`
- Goes to zero as `t_i` goes to zero
- Neutral (i.e. close to 1) when `s_i ~ t_i` that is, the stake contribution fair (proportial to the traffic contribution)
- Excess traffic contributes only sub-linearly to the reward

`D_liveness` is a liveness factor calculated as the percentage of the time the worker is self-reported as online. A worker sends a ping message every 10 seconds, and if there no pings within a minute, the worker is deemed offline for this period of time. The liveness factor is the persentage of the time (with minute-based granularity) the network is live. We suggest a piecewise linear function with the following properties:

- It is `0` below a reasonably high threshold (set to `0.8`)
- Sharply increases to near `1` in the "intermediary" regime `0.8-0.9`
- The penalty around `1` is diminishing

![image](https://user-images.githubusercontent.com/8627422/257277215-5c902bb4-2a90-4847-8a1f-1cd88e46fb54.png)


Finally, `D_tenure` is a long-range liveness factor incentivizing consistent liveness across the epochs. The rationale is that

- The probability of a worker failure decreases with the time the worker is live, thus freshly spawned workers are rewarded less
- The discount for freshly spawned workers discourages the churn among workers and incentivizes longer-term commitments

![image](https://user-images.githubusercontent.com/8627422/257228987-7863df56-8ad3-447d-a095-dae18c1027b3.png)

### Distribution between the worker and delegators

The total claimable reward for the `i`-th worker and the stakers is calculates simply as `r[i] * s[i]`. Clearly, `s[i]` is the sum of the (fixed) bond `b[i]` and the (variable) delegated stake `d[i]`. Thus, the delegator rewards account for `r[i] * d[i]`.  This extra reward part is split between the worker and the delegators:

- The worker gets: `r[i] * b[i] + 0.5 * r[i] * s[i]`
- The delegators get `0.5 * r[i] * s[i]`, effectively attaining `0.5 * r[i]` as the effectual reward rate.

The rationale for this split is:
- Make the worker accountable for `r[i]`
- Incentivize the worker to attract stakers (the additional reward part)
- Incentivize the stakers to stake for a worker with high liveness (and, in general, high `r[i]`)

At an equilibrium, the stakers will get `10%` annual yield, while workers get anything in between `20-30%` depending on the staked funds. Note, that the maximal stake is limited by the bond size.

### Reward commitment and approvals

Out of N whitelisted oracles, each 256 block, one is selected to commit new rewards. As soon as the commitment is approved by 2 other oracles, the rewards are unlocked and can be claimed by the workers and stakers.
