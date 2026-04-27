# Subsquid Network Contracts

<p align="center">
  <img src="https://sqd.dev/brand/Logo_bl-bg.svg" height="100px" />
</p>

This is a monorepo that contains contracts and utils that enable [Subsquid](https://sqd.dev/) decentralised network

Subsquid uses [pnpm](https://pnpm.io/) as a package and monorepo manager.
To install `pnpm`, run `npm install -g pnpm` or consult with [pnpm installation guide](https://pnpm.io/installation).

Install all dependencies using
```bash
pnpm install
```

### Packages:
 - [Subsquid Network Contracts](./packages/contracts)
 - [Portal Contracts](./packages/portal-contracts)
 - [Reward Simulator](./packages/rewards-calculator), process that calculates rewards based on 

 ---

## Deployed addresses

### Ethereum Mainnet

| Contract | Address |
|---|---|
| **SQD** | [`0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`](https://etherscan.io/token/0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1) |

### Base

| Contract | Address |
|---|---|
| **SQD** | [`0xd4554bea546efa83c1e6b389ecac40ea999b3e78`](https://basescan.org/token/0xd4554bea546efa83c1e6b389ecac40ea999b3e78) |

### BNB Smart Chain

| Contract | Address |
|---|---|
| **SQD** | [`0xe50e3d1a46070444f44df911359033f2937fcc13`](https://bscscan.com/token/0xe50e3d1a46070444f44df911359033f2937fcc13) |

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

#### Portal Pool system (Arbitrum One)

Factory and registry are UUPS proxies; pools are beacon proxies (one shared implementation, upgradable in one shot via the beacon).

| Contract | Address |
|---|---|
| **PortalPoolFactory** (UUPS proxy) | [`0x18184740eBE24881355E33cec620C44E575F2C70`](https://arbiscan.io/address/0x18184740eBE24881355E33cec620C44E575F2C70) |
| ↳ Factory implementation | [`0xCe5D796769Ba065Bf61a8eFC892A8a835FAe0351`](https://arbiscan.io/address/0xCe5D796769Ba065Bf61a8eFC892A8a835FAe0351) |
| **PortalRegistry** (UUPS proxy) | [`0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850`](https://arbiscan.io/address/0x29edE9EB0ad3C02B6A98B0E41bF99Cd709812850) |
| ↳ Registry implementation | [`0xC3725B2584Ad46c52f9eFA6F27d0291E3dbC3045`](https://arbiscan.io/address/0xC3725B2584Ad46c52f9eFA6F27d0291E3dbC3045) |
| **PortalPoolBeacon** | [`0x16983f5a5816d4B04c92Ab43Fed3B2F212D4e568`](https://arbiscan.io/address/0x16983f5a5816d4B04c92Ab43Fed3B2F212D4e568) |
| ↳ PortalPoolImplementation (current) | [`0x2981E64342fc76d531168Cf6754F81422138b3C4`](https://arbiscan.io/address/0x2981E64342fc76d531168Cf6754F81422138b3C4) |
| **FeeRouterModule** | [`0x59c074ee3dd85125620B4A5b452C008Bc792a787`](https://arbiscan.io/address/0x59c074ee3dd85125620B4A5b452C008Bc792a787) |

##### Live pools

| Pool | Address | plSQD receipt token |
|---|---|---|
| **Lambda × SQD** | [`0x89ca93e09ec7355a1d6bd410fe0bb4c9b24542db`](https://arbiscan.io/address/0x89ca93e09ec7355a1d6bd410fe0bb4c9b24542db) | [`0xF7B057C3b0ee4dd101047B26Fd3964185B7d8cc4`](https://arbiscan.io/token/0xF7B057C3b0ee4dd101047B26Fd3964185B7d8cc4) |
| **SQD Revenue Pool** | [`0x438c2a47e82cd445524ce5651ae7e6c1dd386d09`](https://arbiscan.io/address/0x438c2a47e82cd445524ce5651ae7e6c1dd386d09) | [`0x365709Ef4830B77a6EB4a689F13F57A1C22d8306`](https://arbiscan.io/token/0x365709Ef4830B77a6EB4a689F13F57A1C22d8306) |

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
