# Panthalasa smart contracts

## Installation

The contracts are written on top of the foundry framework. See [getfoundry.sh](https://getfoundry.sh/) to install it.
To install all necessary node packages, run 
```bash
pnpm i
```
Build the contracts with
```bash
pnpm build
```

The repo has the followings structure:

- `src` contract sources
- `deploy` foundry deployment scripts (use with `forge scripts Deploy.s.sol`)
- `deployments` deployment artifacts
- `artifacts` compiled contracts
- `scripts` utility scripts

## Deployment and testing
To deploy contracts, run
```bash
PRIVATE_KEY=0x.... pnpm run deploy
```
where `PRIVATE_KEY` is the private key of the account that will deploy the contracts.

To run tests, run
```bash
pnpm run test
```

## Brief contracts description

- [DistributedRewardDistributor.sol](./src/DistributedRewardDistribution.sol) - receives awarded rewards from whitelisted oracles
- [RewardTreasury.sol](./src/RewardTreasury.sol) - stores funds for rewards that can be claimed by workers and stakers
- [Staking.sol](./src/Staking.sol) - distributes rewards to stakers proportionally to their stake
- [WorkerRegistration.sol](./src/WorkerRegistration.sol) - register and manage workers
- [RewardCalculation.sol](./src/RewardCalculation.sol) - read only contract that calculates current APY
- [NetworkController.sol](./src/NetworkController.sol) - manages network parameters

### Deployed contracts

#### Sepolia

| Contract                       | Address                                                                                                                       |
|--------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| tSQD                           | [0x2a5d6A3F9D31c798B1772B0c70Ae8bd69988aD11](https://sepolia.etherscan.io/address/0x2a5d6A3F9D31c798B1772B0c70Ae8bd69988aD11) |

#### Arbitrum-sepolia

| Contract                       | Address                                                                                                                      |
|--------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| tSQD                           | [0x0D3934b08AdB5fbe30F48B3A18ba636460655B7E](https://sepolia.arbiscan.io/address/0x0D3934b08AdB5fbe30F48B3A18ba636460655B7E) |
| WorkerRegistration             | [0x1b188e52CEC575A359B1FAa4649a0739BD4442a4](https://sepolia.arbiscan.io/address/0x1b188e52CEC575A359B1FAa4649a0739BD4442a4) |
| Staking                        | [0x87BCF96A0f1e898a3434Fd1C588D13e2ac27268c](https://sepolia.arbiscan.io/address/0x87BCF96A0f1e898a3434Fd1C588D13e2ac27268c) |
| GatewayRegistry                | [0x796426d5266645245476EDcEb63e751cA043304D](https://sepolia.arbiscan.io/address/0x796426d5266645245476EDcEb63e751cA043304D) |
| Router                         | [0xB441f351a14a520496ec30d91b4DC1D2E54505B5](https://sepolia.arbiscan.io/address/0xB441f351a14a520496ec30d91b4DC1D2E54505B5) |
| NetworkController              | [0x4e0E874B7FdE824c8C16903E96a1E35bD8b9ba89](https://sepolia.arbiscan.io/address/0x4e0E874B7FdE824c8C16903E96a1E35bD8b9ba89) |
| RewardTreasury                 | [0x85E8491383a38BE3d266a79F8532fa9d6f34c894](https://sepolia.arbiscan.io/address/0x85E8491383a38BE3d266a79F8532fa9d6f34c894) |
| DistributedRewardsDistribution | [0x1b4917E9c462CfB36f9A1762f6c0aCb04f5968B8](https://sepolia.arbiscan.io/address/0x1b4917E9c462CfB36f9A1762f6c0aCb04f5968B8) |
| RewardCalculation              | [0xE7F569CF32453A655071D3736Bf105d90cC4363b](https://sepolia.arbiscan.io/address/0xE7F569CF32453A655071D3736Bf105d90cC4363b) |
| VestingFactory                 | [0x100Fe660683Fa04B5b23aefe7CA71c9196d68e40](https://sepolia.arbiscan.io/address/0x100Fe660683Fa04B5b23aefe7CA71c9196d68e40) |

#### Arbitrum-goerli

| Contract                       | Address                                                                                                                     |
|--------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| tSQD                           | [0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9](https://goerli.arbiscan.io/address/0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9) |
| DistributedRewardsDistribution | [0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9](https://goerli.arbiscan.io/address/0x69f643dCa8B633F97e2fC979E8eBa6cB63B242A9) |
| RewardTreasury                 | [0x87F1B67c10237CBB32019EF33052B96940994149](https://goerli.arbiscan.io/address/0x87F1B67c10237CBB32019EF33052B96940994149) |
| Staking                        | [0x99Fa79f673ffa4354e96670999cb67A0d43de4C1](https://goerli.arbiscan.io/address/0x99Fa79f673ffa4354e96670999cb67A0d43de4C1) |
| WorkerRegistration             | [0x6867E96A0259E68A571a368C0b8d733Aa56E3915](https://goerli.arbiscan.io/address/0x6867E96A0259E68A571a368C0b8d733Aa56E3915) |
| RewardCalculation              | [0xC60CA978Bf5A9E2374B82D346d1B36Fd35D27991](https://goerli.arbiscan.io/address/0xC60CA978Bf5A9E2374B82D346d1B36Fd35D27991) |
| NetworkController              | [0xF0512AD4f8945Ba47B9100609122B4B2769cA99C](https://goerli.arbiscan.io/address/0xF0512AD4f8945Ba47B9100609122B4B2769cA99C) |

## Worker registration

Before running the script, consult `.env` and check the variables:

```
# RPC URL, tries to connect to 127.0.0.1:8545 by default
RPC_PROVIDER_URL=
# should match one of the networks in the /deployments folder, localhost by default
NETWORK_NAME=
```

Run 
```
pnpm run register-worker [base58PeerID] [privateKey]
```
to register a worker. The provided account must have 100k tSQD for bonding and some gas fee tokens.

Example:
```
pnpm run register-worker QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

## Active Workers 

Before running the script, consult `.env` and check the variables:

```
# RPC URL, tries to connect to 127.0.0.1:8545 by default
RPC_PROVIDER_URL=
# should match one of the networks in the /deployments folder, localhost by default
NETWORK_NAME=
```

To list currently active workers, run
```
npm run list-workers
```
