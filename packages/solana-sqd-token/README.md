# SQD Solana Token

This package mirrors the fixed-supply `SQD` ERC-20 token on Solana as a standard SPL mint.

## What was ported from the EVM contracts

The existing EVM token in [packages/contracts/src/SQD.sol](/Users/gradonsky/SQD/sqd-migration/subsquid-network-contracts/packages/contracts/src/SQD.sol:1) has a few important properties:

- Name: `SQD Token`
- Symbol: `SQD`
- Decimals: `18`
- Fixed initial supply: `1,337,000,000 SQD`
- No ongoing mint schedule in the token contract itself

The broader EVM system uses that token in staking, worker bonding, rewards, vesting, and gateway staking. Those protocol contracts are EVM-specific and are not reimplemented here. This Solana package focuses on the token primitive itself.

## Important Solana constraint

Standard SPL token balances are stored as `u64`. That means the EVM base-unit supply of:

`1,337,000,000 * 10^18 = 1,337,000,000,000,000,000,000,000,000`

cannot fit into an SPL mint.

To keep the same whole-token supply on Solana while staying within SPL limits, this package uses:

- Solana decimals: `10`
- Whole-token supply: `1,337,000,000 SQD`
- Solana base-unit supply: `13,370,000,000,000,000,000`

`10` is the maximum decimal precision that still fits `1,337,000,000 SQD` into the SPL `u64` amount model.

## Solana design

On Solana, the equivalent primitive is a standard SPL mint rather than a custom token program. The CLI in this folder:

1. Creates a mint with `10` decimals.
2. Creates the recipient's associated token account.
3. Mints the full fixed SQD supply once.
4. Revokes mint authority and freeze authority.

That gives us the same fixed-supply whole-token behavior as the current ERC-20 token deployment, within SPL's amount limits.

## Scripts

```bash
pnpm --filter @subsquid-network/solana-sqd-token create:mint -- --rpc-url http://127.0.0.1:8899
pnpm --filter @subsquid-network/solana-sqd-token test
```

CLI options:

- `--rpc-url`: Solana RPC endpoint. Defaults to `http://127.0.0.1:8899`.
- `--keypair`: fee payer keypair path. Defaults to `~/.config/solana/id.json`.
- `--recipient`: recipient public key. Defaults to the fee payer.
- `--mint-keypair`: optional mint keypair file. If the file does not exist, it will be generated and saved.

## Notes

- Tests run against `solana-bankrun`, so they do not require `solana-test-validator`.
- This package does not attach Metaplex metadata yet. Standard SPL tokens do not store `name` and `symbol` in the mint account itself.
- The Arbitrum bridge helper from the EVM token is intentionally not ported, because Solana bridging requires a different bridge stack.
