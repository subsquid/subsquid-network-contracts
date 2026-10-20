import assert from "node:assert/strict";
import test from "node:test";

import { MINT_SIZE } from "@solana/spl-token";
import { Keypair, Transaction } from "@solana/web3.js";
import { start } from "solana-bankrun";
import { createAssociatedTokenAccount, getAccount, getMint, transfer } from "spl-token-bankrun";

import {
  EVM_SQD_TOKEN_DECIMALS,
  EVM_SQD_TOTAL_SUPPLY,
  MAX_SOLANA_DECIMALS_FOR_SQD_SUPPLY,
  SOLANA_U64_MAX,
  SQD_TOKEN_DECIMALS,
  SQD_TOKEN_NAME,
  SQD_TOKEN_SYMBOL,
  SQD_TOTAL_SUPPLY,
  SQD_WHOLE_SUPPLY
} from "../src/constants.js";
import { buildCreateSqdMintInstructions } from "../src/sqdMint.js";

test("SQD Solana constants preserve whole-token supply within SPL limits", () => {
  assert.equal(SQD_TOKEN_NAME, "SQD Token");
  assert.equal(SQD_TOKEN_SYMBOL, "SQD");
  assert.equal(EVM_SQD_TOKEN_DECIMALS, 18);
  assert.equal(MAX_SOLANA_DECIMALS_FOR_SQD_SUPPLY, 10);
  assert.equal(SQD_TOKEN_DECIMALS, 10);
  assert.equal(SQD_WHOLE_SUPPLY, 1_337_000_000n);
  assert.equal(EVM_SQD_TOTAL_SUPPLY, 1_337_000_000n * 10n ** 18n);
  assert.equal(SQD_TOTAL_SUPPLY, 1_337_000_000n * 10n ** 10n);
  assert.equal(SQD_TOTAL_SUPPLY <= SOLANA_U64_MAX, true);
});

test("creates a fixed-supply SQD SPL token and allows transfers", async () => {
  const context = await start([], []);
  const banksClient = context.banksClient;
  const payer = context.payer;
  const recipient = Keypair.generate();
  const receiver = Keypair.generate();
  const mintKeypair = Keypair.generate();
  const rent = await banksClient.getRent();

  const { instructions, recipientAtaAddress } = buildCreateSqdMintInstructions({
    payerAddress: payer.publicKey,
    mintAddress: mintKeypair.publicKey,
    recipientAddress: recipient.publicKey,
    mintAuthorityAddress: payer.publicKey,
    lamportsForMint: Number(await rent.minimumBalance(BigInt(MINT_SIZE)))
  });
  const createMintTx = new Transaction();
  const [mintBlockhash] = (await banksClient.getLatestBlockhash()) ?? [];
  createMintTx.recentBlockhash = mintBlockhash;
  createMintTx.feePayer = payer.publicKey;
  createMintTx.add(...instructions);
  createMintTx.sign(payer, mintKeypair);
  await banksClient.processTransaction(createMintTx);

  const mint = await getMint(banksClient, mintKeypair.publicKey);
  assert.equal(mint.address.toBase58(), mintKeypair.publicKey.toBase58());
  assert.equal(mint.decimals, SQD_TOKEN_DECIMALS);
  assert.equal(mint.supply, SQD_TOTAL_SUPPLY);
  assert.equal(mint.mintAuthority, null);
  assert.equal(mint.freezeAuthority, null);

  const recipientAccount = await getAccount(banksClient, recipientAtaAddress);
  assert.equal(recipientAccount.amount, SQD_TOTAL_SUPPLY);

  const receiverAta = await createAssociatedTokenAccount(
    banksClient,
    payer,
    mintKeypair.publicKey,
    receiver.publicKey
  );

  const transferAmount = 25n * 10n ** BigInt(SQD_TOKEN_DECIMALS);
  await transfer(banksClient, payer, recipientAtaAddress, receiverAta, recipient, transferAmount);

  const updatedRecipientAccount = await getAccount(banksClient, recipientAtaAddress);
  const updatedReceiverAccount = await getAccount(banksClient, receiverAta);

  assert.equal(updatedRecipientAccount.amount, SQD_TOTAL_SUPPLY - transferAmount);
  assert.equal(updatedReceiverAccount.amount, transferAmount);
});
