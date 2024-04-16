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
| **Router**                         | [0xD2093610c5d27c201CD47bCF1Df4071610114b64](https://sepolia.arbiscan.io/address/0xD2093610c5d27c201CD47bCF1Df4071610114b64) |
| **NetworkController**              | [0x68Fc7E375945d8C8dFb0050c337Ff09E962D976D](https://sepolia.arbiscan.io/address/0x68Fc7E375945d8C8dFb0050c337Ff09E962D976D) |
| **Staking**                        | [0x347E326b8b4EA27c87d5CA291e708cdEC6d65EB5](https://sepolia.arbiscan.io/address/0x347E326b8b4EA27c87d5CA291e708cdEC6d65EB5) |
| **WorkerRegistration**             | [0xCD8e983F8c4202B0085825Cf21833927D1e2b6Dc](https://sepolia.arbiscan.io/address/0xCD8e983F8c4202B0085825Cf21833927D1e2b6Dc) |
| **RewardTreasury**                 | [0x785136e611E15D532C36502AaBdfE8E35008c7ca](https://sepolia.arbiscan.io/address/0x785136e611E15D532C36502AaBdfE8E35008c7ca) |
| **DistributedRewardsDistribution** | [0x68f9fE3504652360afF430dF198E1Cb7B2dCfD57](https://sepolia.arbiscan.io/address/0x68f9fE3504652360afF430dF198E1Cb7B2dCfD57) |
| **GatewayRegistry**                | [0xAB46F688AbA4FcD1920F21E9BD16B229316D8b0a](https://sepolia.arbiscan.io/address/0xAB46F688AbA4FcD1920F21E9BD16B229316D8b0a) |
| **VestingFactory**                 | [0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca](https://sepolia.arbiscan.io/address/0x0eD5FB811167De1928322a0fa30Ed7F3c8C370Ca) |
| **RewardCalculation**              | [0x93D16d5210122c804DE9931b41b3c6FA2649CE3F](https://sepolia.arbiscan.io/address/0x93D16d5210122c804DE9931b41b3c6FA2649CE3F) |
| **EqualStrategy**              | [0x94DF0410BF415765e8e9431d545AF9805859b5Db](https://sepolia.arbiscan.io/address/0x94DF0410BF415765e8e9431d545AF9805859b5Db) |
| **SubequalStrategy**              | [0x20cA692986D127CE78938E2518cE2F49F105eC48](https://sepolia.arbiscan.io/address/0x20cA692986D127CE78938E2518cE2F49F105eC48) |
| **AllocationsViewer**              | [0xC0Af6432947db51e0C179050dAF801F19d40D2B7](https://sepolia.arbiscan.io/address/0xC0Af6432947db51e0C179050dAF801F19d40D2B7) |

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
