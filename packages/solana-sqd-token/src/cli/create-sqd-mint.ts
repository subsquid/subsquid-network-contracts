import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  EVM_SQD_TOKEN_DECIMALS,
  EVM_SQD_TOTAL_SUPPLY,
  SQD_TOKEN_DECIMALS,
  SQD_TOKEN_NAME,
  SQD_TOKEN_SYMBOL,
  SQD_TOTAL_SUPPLY
} from "../constants.js";
import { loadKeypairFromFile, loadOrCreateKeypair, resolvePath } from "../keypair.js";
import { createSqdMint, fetchSqdMint } from "../sqdMint.js";

const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
const DEFAULT_KEYPAIR_PATH = "~/.config/solana/id.json";

function printUsage() {
  console.log(`Usage:
  pnpm --filter @subsquid-network/solana-sqd-token create:mint -- [options]

Options:
  --rpc-url <url>         Solana RPC endpoint (default: ${DEFAULT_RPC_URL})
  --keypair <path>        Fee payer keypair path (default: ${DEFAULT_KEYPAIR_PATH})
  --recipient <pubkey>    Recipient of the full SQD supply (default: fee payer)
  --mint-keypair <path>   Optional mint keypair file; creates one if missing
  --help                  Show this message
`);
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      "rpc-url": { type: "string", default: DEFAULT_RPC_URL },
      keypair: { type: "string", default: DEFAULT_KEYPAIR_PATH },
      recipient: { type: "string" },
      "mint-keypair": { type: "string" },
      help: { type: "boolean", default: false }
    }
  });

  if (values.help) {
    printUsage();
    return;
  }

  const connection = new Connection(values["rpc-url"], "confirmed");
  const payer = loadKeypairFromFile(values.keypair);
  const recipient = values.recipient ? new PublicKey(values.recipient) : payer.publicKey;

  let mintKeypair: Keypair | undefined;
  let mintKeypairPath: string | undefined;
  let mintKeypairCreated = false;

  if (values["mint-keypair"]) {
    const targetPath = resolvePath(values["mint-keypair"]);
    mintKeypairPath = targetPath;
    if (existsSync(targetPath)) {
      mintKeypair = loadKeypairFromFile(targetPath);
    } else {
      const created = loadOrCreateKeypair(targetPath);
      mintKeypair = created.keypair;
      mintKeypairCreated = created.created;
    }
  } else {
    mintKeypair = Keypair.generate();
  }

  const result = await createSqdMint({
    connection,
    payer,
    recipient,
    mintKeypair
  });
  const mintState = await fetchSqdMint(connection, result.mintAddress);

  console.log(
    JSON.stringify(
      {
        token: {
          name: SQD_TOKEN_NAME,
          symbol: SQD_TOKEN_SYMBOL,
          decimals: SQD_TOKEN_DECIMALS,
          totalSupply: SQD_TOTAL_SUPPLY.toString(),
          evmDecimals: EVM_SQD_TOKEN_DECIMALS,
          evmTotalSupply: EVM_SQD_TOTAL_SUPPLY.toString()
        },
        cluster: values["rpc-url"],
        payer: payer.publicKey.toBase58(),
        recipient: result.recipientAddress.toBase58(),
        mintAddress: result.mintAddress.toBase58(),
        recipientAtaAddress: result.recipientAtaAddress.toBase58(),
        signature: result.signature,
        mintAuthorityRevoked: mintState.mintAuthority === null,
        freezeAuthorityRevoked: mintState.freezeAuthority === null,
        mintKeypairPath,
        mintKeypairCreated
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
