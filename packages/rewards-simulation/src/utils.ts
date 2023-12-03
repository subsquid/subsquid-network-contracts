import { formatEther } from "viem";
import bs58 from "bs58";
const { decode, encode } = bs58;
export function keysToFixed(object: Object) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      typeof value === "number" ? value.toFixed(2) : value,
    ]),
  );
}

export function sum(array: number[]) {
  return array.reduce((acc, value) => acc + value, 0);
}

export function bigSum(array: bigint[]) {
  return array.reduce((acc, value) => acc + value, 0n);
}

export function formatSqd(value: bigint) {
  return formatEther(value).replace(/(\.\d{3})\d+/, "$1");
}

export function fromBase58(value: string): `0x${string}` {
  return `0x${Buffer.from(decode(value)).toString("hex")}`;
}

export function toBase58(value: `0x${string}`): string {
  return encode(Buffer.from(value.slice(2), "hex"));
}
