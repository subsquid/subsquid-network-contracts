import { formatEther } from "viem";
import bs58 from "bs58";

import Decimal from "decimal.js";
Decimal.set({ precision: 28, minE: -9 });

const { decode, encode } = bs58;
export function keysToFixed(object: Object) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      typeof value === "number" || value instanceof Decimal
        ? value.toFixed(2)
        : value,
    ]),
  );
}

export function sum(array: number[]) {
  return array.reduce((acc, value) => acc + value, 0);
}

export function bigSum(array: bigint[]) {
  return array.reduce((acc, value) => acc + value, 0n);
}

export function decimalSum(array: Decimal[]) {
  return array.reduce((acc, value) => acc.add(value), new Decimal(0));
}

export function bigIntToDecimal(value: BigInt) {
  return new Decimal(value.toString());
}

export function decimalToBigInt(value: Decimal) {
  return BigInt(value.round().toFixed(0));
}

export function formatSqd(value: Decimal) {
  return formatEther(decimalToBigInt(value)).replace(/(\.\d{3})\d+/, "$1");
}

export function fromBase58(value: string): `0x${string}` {
  return `0x${Buffer.from(decode(value)).toString("hex")}`;
}

export function toBase58(value: `0x${string}`): string {
  return encode(Buffer.from(value.slice(2), "hex"));
}

export function withCache<T extends (...args: any[]) => Promise<any>>(func: T): T {
  const cache = new Map<string, ReturnType<T>>();

  return (async function (...args: Parameters<T>): Promise<ReturnType<T>> {
    // Custom key generator to handle BigInt
    const key = args
      .map(arg => (typeof arg === 'bigint' ? `bigint:${arg}` : JSON.stringify(arg)))
      .join('|');

    if (cache.has(key)) {
      console.log('Returning from cache:', key);
      return cache.get(key)!;
    }

    const result = await func(...args);
    cache.set(key, result);
    return result;
  }) as T;
}