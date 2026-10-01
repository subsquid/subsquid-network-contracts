import bs58 from 'bs58';
import Decimal from 'decimal.js';
import { formatEther } from 'viem';

Decimal.set({ precision: 28 });

const { decode, encode } = bs58;
export function keysToFixed(object: Object) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      typeof value === 'number' || value instanceof Decimal
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
  return formatEther(decimalToBigInt(value)).replace(/(\.\d{3})\d+/, '$1');
}

export function fromBase58(value: string): `0x${string}` {
  return `0x${Buffer.from(decode(value)).toString('hex')}`;
}

export function toBase58(value: `0x${string}`): string {
  return encode(Buffer.from(value.slice(2), 'hex'));
}

type CacheEntry<R> = { result: Promise<R>; expiresAt?: number };

export function withCache<A extends unknown[], R>(
  func: (...args: A) => Promise<R>,
  {
    ttl = Infinity,
    maxEntries = Infinity,
  }: { ttl?: number; maxEntries?: number } = {},
): (...args: A) => Promise<R> {
  // A pending entry has no expiry and is never evicted, so calls with the same
  // args share one execution however long it runs. The ttl starts on success.
  const cache = new Map<string, CacheEntry<R>>();

  const isExpired = (entry: CacheEntry<R>, now: number) =>
    entry.expiresAt !== undefined && entry.expiresAt <= now;

  return (...args: A): Promise<R> => {
    // Custom key generator to handle BigInt
    const key = args
      .map((arg) =>
        JSON.stringify(arg, (_, v) =>
          typeof v === 'bigint' ? `bigint:${v.toString()}` : v,
        ),
      )
      .join('|');
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && !isExpired(cached, now)) {
      return cached.result;
    }

    for (const [k, entry] of cache) {
      if (isExpired(entry, now)) cache.delete(k);
    }
    if (cache.size >= maxEntries) {
      const oldestSettled = [...cache].find(
        ([, entry]) => entry.expiresAt !== undefined,
      );
      if (oldestSettled) cache.delete(oldestSettled[0]);
    }

    const result = func(...args);
    const entry: CacheEntry<R> = { result };
    cache.set(key, entry);

    result.then(
      () => {
        entry.expiresAt = Date.now() + ttl;
      },
      () => {
        // Failures are not cached, so the next call retries.
        if (cache.get(key) === entry) cache.delete(key);
      },
    );

    return result;
  };
}
