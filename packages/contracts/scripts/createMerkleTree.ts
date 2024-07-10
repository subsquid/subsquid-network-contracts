import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import fs from "fs";
import { utils } from "ethers";

const walletMap: any = {};

function parseCsvLine(text: string, index: number): [number, string, string] {
  const parts = text.split(",");
  if (parts.length !== 2) {
    throw new Error(`Invalid CSV line at index ${index}`);
  }
  return [
    index + 1,
    parts[0].toLowerCase(),
    utils.parseEther(parts[1].trim()).toString(),
  ] as [number, string, string];
}

const leaves = fs
  .readFileSync("./airdrop.csv")
  .toString()
  .split("\n")
  .slice(1)
  .filter((line) => line)
  .map(parseCsvLine);

console.log(`Generating leaves for ${leaves.length} wallets.`);
let total = 0n;

for (const leaf of leaves) {
  const wallet = leaf[1];
  if (walletMap[wallet]) {
    throw new Error(`Duplicate wallet ${wallet}`);
  }
  walletMap[wallet] = leaf;
  total += BigInt(leaf[2]);
}

fs.writeFileSync("airdrop-data/leaves.json", JSON.stringify(walletMap));
console.log(`Finished generating leaves.json.`);
console.log(`Total distribution: ${total}`);

const tree = StandardMerkleTree.of(leaves, ["uint32", "address", "uint256"]);

console.log(`Finished creating MerkleTree with ${leaves.length} leaves.`);
console.log(`Root: ${tree.root}`);

fs.writeFileSync("airdrop-data/tree.json", JSON.stringify(tree.dump()));
