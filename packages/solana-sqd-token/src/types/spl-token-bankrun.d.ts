declare module "spl-token-bankrun" {
  import type { Account, Mint } from "@solana/spl-token";
  import type { Keypair, PublicKey, Signer } from "@solana/web3.js";
  import type { BanksClient, BanksTransactionMeta } from "solana-bankrun";

  export function createAssociatedTokenAccount(
    banksClient: BanksClient,
    payer: Signer,
    mint: PublicKey,
    owner: PublicKey
  ): Promise<PublicKey>;

  export function getAccount(banksClient: BanksClient, address: PublicKey): Promise<Account>;

  export function getMint(banksClient: BanksClient, address: PublicKey): Promise<Mint>;

  export function transfer(
    banksClient: BanksClient,
    payer: Signer,
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey | Keypair | Signer,
    amount: number | bigint
  ): Promise<BanksTransactionMeta>;
}
