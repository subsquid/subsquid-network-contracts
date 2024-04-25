export function fordefiRequest(to: string, data: string, name: string) {
  return {
    signer_type: "api_signer",
    type: "evm_transaction",
    details: {
      type: "evm_raw_transaction",
      to,
      value: "0",
      gas: {
        type: "priority",
        priority_level: "low",
      },
      chain: "arbitrum_sepolia",
      data: {
        type: "hex",
        hex_data: data,
      },
    },
    note: name,
    vault_id: process.env.FORDEFI_VAULT_ID,
  };
}
