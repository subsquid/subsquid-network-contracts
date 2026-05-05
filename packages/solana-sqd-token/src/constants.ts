export const SQD_TOKEN_NAME = "SQD Token";
export const SQD_TOKEN_SYMBOL = "SQD";
export const SQD_WHOLE_SUPPLY = 1_337_000_000n;
export const EVM_SQD_TOKEN_DECIMALS = 18;
export const SOLANA_U64_MAX = 2n ** 64n - 1n;
export const MAX_SOLANA_DECIMALS_FOR_SQD_SUPPLY = 10;
export const SQD_TOKEN_DECIMALS = MAX_SOLANA_DECIMALS_FOR_SQD_SUPPLY;
export const SQD_TOTAL_SUPPLY = SQD_WHOLE_SUPPLY * 10n ** BigInt(SQD_TOKEN_DECIMALS);
export const EVM_SQD_TOTAL_SUPPLY = SQD_WHOLE_SUPPLY * 10n ** BigInt(EVM_SQD_TOKEN_DECIMALS);

if (SQD_TOTAL_SUPPLY > SOLANA_U64_MAX) {
  throw new Error("SQD total supply exceeds the SPL Token u64 limit");
}
