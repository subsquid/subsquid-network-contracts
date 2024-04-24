import { Hex } from "viem";

export async function getVaultAddress(): Promise<Hex> {
  const vaultId = process.env.FORDEFI_VAULT_ID;
  if (!vaultId) {
    throw new Error("FORDEFI_VAULT_ID is not set");
  }
  const accessToken = process.env.FORDEFI_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("FORDEFI_ACCESS_TOKEN is not set");
  }
  const request = await fetch(
    `https://api.fordefi.com/api/v1/vaults/${vaultId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!request.ok) {
    throw new Error(await request.text());
  }
  const data = await request.json();
  return data.address;
}
