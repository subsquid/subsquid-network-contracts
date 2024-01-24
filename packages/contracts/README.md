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

| Contract name | Address                                                                                                                     |
|---------------|-----------------------------------------------------------------------------------------------------------------------------|
| **tSQD**      | [0xb0571a833fc49442c030e27295f33049d9e5443b](https://sepolia.etherscan.io/token/0xb0571a833fc49442c030e27295f33049d9e5443b) |

#### Arbitrum-sepolia

| Contract name                      | Address.                                                                                                                     |
|------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| **tSQDArbitrum**                   | [0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c](https://sepolia.arbiscan.io/token/0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c)   |
| **Router**                         | [0x6bAc05cDe58D02953496541b4d615f71a5Db57a3](https://sepolia.arbiscan.io/address/0x6bAc05cDe58D02953496541b4d615f71a5Db57a3) |
| **NetworkController**              | [0xa4285F5503D903BB10978AD652D072e79cc92F0a](https://sepolia.arbiscan.io/address/0xa4285F5503D903BB10978AD652D072e79cc92F0a) |
| **Staking**                        | [0x2B0D385DBC2Eb2946448d1f6be6bfa9Bb53F68C9](https://sepolia.arbiscan.io/address/0x2B0D385DBC2Eb2946448d1f6be6bfa9Bb53F68C9) |
| **WorkerRegistration**             | [0x7Bf0B1ee9767eAc70A857cEbb24b83115093477F](https://sepolia.arbiscan.io/address/0x7Bf0B1ee9767eAc70A857cEbb24b83115093477F) |
| **RewardTreasury**                 | [0xBE8518812597C37FA807b1B8A4a3Bb98849E67ab](https://sepolia.arbiscan.io/address/0xBE8518812597C37FA807b1B8A4a3Bb98849E67ab) |
| **DistributedRewardsDistribution** | [0xcD7560602c6583a1E6dc38df271A3aB5A2023D9b](https://sepolia.arbiscan.io/address/0xcD7560602c6583a1E6dc38df271A3aB5A2023D9b) |
| **GatewayRegistry**                | [0xFb1754Fa0FC1892F9bF0B072F5C7b0a4e6f5d247](https://sepolia.arbiscan.io/address/0xFb1754Fa0FC1892F9bF0B072F5C7b0a4e6f5d247) |
| **VestingFactory**                 | [0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca](https://sepolia.arbiscan.io/address/0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca) |
| **RewardCalculation**              | [0xA60Ce3598A94AE2a7E381aDe710f3C747A590CFB](https://sepolia.arbiscan.io/address/0xA60Ce3598A94AE2a7E381aDe710f3C747A590CFB) |

#### Arbitrum-goerli

| Contract name                  | Address                                                                                                                     |
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
