import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Keypair } from "@solana/web3.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function resolvePath(inputPath: string): string {
  return path.resolve(expandHome(inputPath));
}

export function loadKeypairFromFile(filePath: string): Keypair {
  const absolutePath = resolvePath(filePath);
  const contents = readFileSync(absolutePath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(contents) as number[]);
  return Keypair.fromSecretKey(secretKey);
}

export function loadOrCreateKeypair(filePath: string): { keypair: Keypair; filePath: string; created: boolean } {
  const absolutePath = resolvePath(filePath);
  if (existsSync(absolutePath)) {
    return { keypair: loadKeypairFromFile(absolutePath), filePath: absolutePath, created: false };
  }

  const keypair = Keypair.generate();
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, JSON.stringify(Array.from(keypair.secretKey)));
  return { keypair, filePath: absolutePath, created: true };
}
