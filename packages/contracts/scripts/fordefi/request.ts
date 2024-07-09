export function fordefiRequest(
  to: string,
  amount: string,
  name: string,
  chain: "mainnet" | "sepolia",
  tokenAddr: string,
) {
  return {
    signer_type: "api_signer",
    type: "evm_transaction",
    details: {
      type: "evm_transfer",
      to,
      gas: {
        type: "priority",
        priority_level: "low",
      },
      chain: chain === "sepolia" ? "arbitrum_sepolia" : "arbitrum_mainnet",
      asset_identifier: {
        type: "evm",
        details: {
          type: "erc20",
          token: {
            chain:
              chain === "sepolia"
                ? "evm_arbitrum_sepolia"
                : "evm_arbitrum_mainnet",
            hex_repr: tokenAddr,
          },
        },
      },
      value: {
        type: "value",
        value: amount,
      },
    },
    note: name,
    vault_id: process.env.FORDEFI_VAULT_ID,
  };
}
