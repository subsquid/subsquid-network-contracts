export function fordefiRequest(to: string, amount: string, name: string) {
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
      chain: "arbitrum_sepolia",
      asset_identifier: {
        type: "evm",
        details: {
          type: "erc20",
          token: {
            chain: "evm_arbitrum_sepolia",
            hex_repr: "0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c",
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
