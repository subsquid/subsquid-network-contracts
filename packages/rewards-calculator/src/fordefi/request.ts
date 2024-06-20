import { config } from "../config";

export function fordefiRequest(to: string, data: string, name: string) {
  const chain =
    config.network.networkName === "sepolia"
      ? "arbitrum_sepolia"
      : "arbitrum_mainnet";

  return {
    signer_type: "api_signer",
    type: "evm_transaction",
    details: {
      type: "evm_raw_transaction",
      to,
      value: "0",
      gas: {
        type: "custom",
        details: {
          type: "dynamic",
          max_fee_per_gas: "10000000",
          max_priority_fee_per_gas: "10000000",
        },
      },
      fail_on_prediction_failure: false,
      chain,
      data: {
        type: "hex",
        hex_data: data,
      },
    },
    note: name,
    vault_id: process.env.FORDEFI_VAULT_ID,
  };
}
