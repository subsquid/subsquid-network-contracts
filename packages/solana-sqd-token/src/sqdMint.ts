import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  getMint
} from "@solana/spl-token";
import {
  Connection,
  type ConfirmOptions,
  type Keypair,
  PublicKey,
  type TransactionInstruction,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";

import { SQD_TOKEN_DECIMALS, SQD_TOTAL_SUPPLY } from "./constants.js";

export interface CreateSqdMintParams {
  connection: Connection;
  payer: Keypair;
  recipient?: PublicKey;
  mintKeypair?: Keypair;
  confirmOptions?: ConfirmOptions;
}

export interface CreateSqdMintResult {
  mintAddress: PublicKey;
  recipientAddress: PublicKey;
  recipientAtaAddress: PublicKey;
  signature: string;
}

export interface BuildCreateSqdMintInstructionsParams {
  payerAddress: PublicKey;
  mintAddress: PublicKey;
  recipientAddress: PublicKey;
  mintAuthorityAddress?: PublicKey;
  lamportsForMint: number;
}

export interface BuildCreateSqdMintInstructionsResult {
  recipientAtaAddress: PublicKey;
  instructions: TransactionInstruction[];
}

export function buildCreateSqdMintInstructions({
  payerAddress,
  mintAddress,
  recipientAddress,
  mintAuthorityAddress = payerAddress,
  lamportsForMint
}: BuildCreateSqdMintInstructionsParams): BuildCreateSqdMintInstructionsResult {
  const recipientAtaAddress = getAssociatedTokenAddressSync(mintAddress, recipientAddress);

  return {
    recipientAtaAddress,
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: payerAddress,
        newAccountPubkey: mintAddress,
        space: MINT_SIZE,
        lamports: lamportsForMint,
        programId: TOKEN_PROGRAM_ID
      }),
      createInitializeMintInstruction(mintAddress, SQD_TOKEN_DECIMALS, mintAuthorityAddress, mintAuthorityAddress),
      createAssociatedTokenAccountInstruction(payerAddress, recipientAtaAddress, recipientAddress, mintAddress),
      createMintToInstruction(mintAddress, recipientAtaAddress, mintAuthorityAddress, SQD_TOTAL_SUPPLY),
      createSetAuthorityInstruction(mintAddress, mintAuthorityAddress, AuthorityType.MintTokens, null),
      createSetAuthorityInstruction(mintAddress, mintAuthorityAddress, AuthorityType.FreezeAccount, null)
    ]
  };
}

export async function createSqdMint({
  connection,
  payer,
  recipient = payer.publicKey,
  mintKeypair,
  confirmOptions
}: CreateSqdMintParams): Promise<CreateSqdMintResult> {
  const mint = mintKeypair ?? payer;
  const mintAddress = mint.publicKey;
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const { instructions, recipientAtaAddress } = buildCreateSqdMintInstructions({
    payerAddress: payer.publicKey,
    mintAddress,
    recipientAddress: recipient,
    mintAuthorityAddress: payer.publicKey,
    lamportsForMint: lamports
  });
  const transaction = new Transaction().add(...instructions);

  const signers = mint === payer ? [payer] : [payer, mint];
  const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
    commitment: "confirmed",
    ...confirmOptions
  });

  return {
    mintAddress,
    recipientAddress: recipient,
    recipientAtaAddress,
    signature
  };
}

export async function fetchSqdMint(connection: Connection, mintAddress: PublicKey) {
  return getMint(connection, mintAddress, "confirmed", TOKEN_PROGRAM_ID);
}
