import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCache } from '../src/utils';

describe('withCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one execution between concurrent calls with the same args', async () => {
    const func = vi.fn(async (from: number, to: number) => ({ from, to }));
    const cached = withCache(func);

    const [a, b] = await Promise.all([cached(1, 2), cached(1, 2)]);

    expect(func).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('keys on every argument', async () => {
    const func = vi.fn(async (from: number, to: number) => to - from);
    const cached = withCache(func);

    await cached(1, 2);
    await cached(1, 3);

    expect(func).toHaveBeenCalledTimes(2);
  });

  it('shares a failure between concurrent calls, then retries', async () => {
    const func = vi
      .fn<(n: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('query failed'))
      .mockResolvedValueOnce('ok');
    const cached = withCache(func);

    const failed = await Promise.allSettled([cached(1), cached(1)]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(func).toHaveBeenCalledTimes(1);

    await expect(cached(1)).resolves.toBe('ok');
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('recomputes once the ttl has passed', async () => {
    vi.useFakeTimers();
    const func = vi.fn(async () => Date.now());
    const cached = withCache(func, { ttl: 1000 });

    await cached();
    vi.advanceTimersByTime(999);
    await cached();
    expect(func).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await cached();
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('shares a running call past the ttl and starts the ttl on success', async () => {
    vi.useFakeTimers();
    let finish = (_value: string) => {};
    const func = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const cached = withCache(func, { ttl: 1000 });

    const first = cached();
    vi.advanceTimersByTime(5000);
    expect(cached()).toBe(first);
    expect(func).toHaveBeenCalledTimes(1);

    finish('done');
    await first;
    vi.advanceTimersByTime(999);
    await cached();
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('never evicts a running call to make room', () => {
    const func = vi.fn((_n: number) => new Promise<number>(() => {}));
    const cached = withCache(func, { maxEntries: 1 });

    const first = cached(1);
    cached(2);

    expect(cached(1)).toBe(first);
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const func = vi.fn(async (n: number) => n);
    const cached = withCache(func, { maxEntries: 2 });

    await cached(1);
    await cached(2);
    await cached(3);
    await cached(2);
    await cached(3);
    expect(func).toHaveBeenCalledTimes(3);

    await cached(1);
    expect(func).toHaveBeenCalledTimes(4);
  });
});
