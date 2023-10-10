# Panthalasa smart contracts

The repo has the followings structure:

- `src` contract sources
- `deploy` foundry deployment scripts (use with `forge scripts Deploy.s.sol`)
- `deployments` deployment artifacts
- `artifacts` compiled contracts
- `scripts` utility scripts

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
npm run register-worker [base58PeerID] [privateKey]
```
to register a worker. The provided account must have 100k tSQD for bonding and some gas fee tokens.

Example:
```
npm run register-worker QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
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
