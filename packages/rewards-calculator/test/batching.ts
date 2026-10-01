import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { Workers } from '../src/workers';

/**
 * Rewards are committed in TOTAL_BATCHES groups (4 in production): each epoch
 * pays exactly one batch, and a worker's batch is fixed by the last byte of its
 * base58-decoded peer ID. A worker therefore gets paid every 4th epoch, with the
 * accounting window widened to cover the same span.
 *
 * If this partition ever stops being total or stops being stable, workers
 * silently drop out of the recipient list, which looks identical to "the network
 * decided I earned nothing".
 */

// Ed25519 libp2p peer IDs decode to a 38-byte identity multihash:
// 0x00 0x24 followed by the 36-byte protobuf-wrapped public key.
function peerIdEndingIn(lastByte: number, seed = 1) {
  const bytes = Buffer.alloc(38);
  bytes[0] = 0x00;
  bytes[1] = 0x24;
  bytes[2] = 0x08;
  bytes[3] = 0x01;
  bytes[4] = 0x12;
  bytes[5] = 0x20;
  for (let i = 6; i < 37; i++) bytes[i] = (seed * i) % 251;
  bytes[37] = lastByte;
  return bs58.encode(bytes);
}

const newWorkers = (peerIds: string[]) => {
  const workers = new Workers(null as any);
  for (const id of peerIds) workers.add(id);
  return workers;
};

describe('Workers.filterBatch', () => {
  const TOTAL = 4;
  const peerIds = Array.from({ length: 40 }, (_, i) =>
    peerIdEndingIn(i, i + 1),
  );

  it('partitions the worker set: every worker lands in exactly one batch', () => {
    const seen = new Map<string, number>();
    for (let batch = 0; batch < TOTAL; batch++) {
      const kept = newWorkers(peerIds)
        .filterBatch(batch, TOTAL)
        .map((w) => w.peerId);
      for (const id of kept) {
        expect(seen.has(id), `${id} appeared in two batches`).to.equal(false);
        seen.set(id, batch);
      }
    }
    expect(seen.size, 'some workers were never paid by any batch').to.equal(
      peerIds.length,
    );
  });

  it('assigns a batch from the last decoded byte modulo the batch count', () => {
    for (let lastByte = 0; lastByte < 12; lastByte++) {
      const id = peerIdEndingIn(lastByte, lastByte + 3);
      const expected = lastByte % TOTAL;
      const kept = newWorkers([id])
        .filterBatch(expected, TOTAL)
        .map((w) => w.peerId);
      expect(
        kept,
        `peer ending in ${lastByte} should be in batch ${expected}`,
      ).to.deep.equal([id]);
    }
  });

  it('is stable: the same peer ID always resolves to the same batch', () => {
    const id = peerIdEndingIn(7, 11);
    const batches = [0, 1, 2, 3].filter(
      (b) => newWorkers([id]).filterBatch(b, TOTAL).count() === 1,
    );
    expect(batches).to.deep.equal([3]); // 7 % 4
  });

  it('places the real mainnet worker 115 in batch 0', () => {
    // Regression anchor against a peer ID observed on-chain: its decoded final
    // byte is 0x24 (36), and 36 % 4 === 0.
    const id = '12D3KooWMrm388Snq84RnYA9k7m2eFhYdQ4goaSAXWwXZWSBy8bu';
    expect(newWorkers([id]).filterBatch(0, TOTAL).count()).to.equal(1);
    for (const b of [1, 2, 3]) {
      expect(
        newWorkers([id]).filterBatch(b, TOTAL).count(),
        `batch ${b}`,
      ).to.equal(0);
    }
  });

  it('keeps everyone when there is a single batch', () => {
    expect(newWorkers(peerIds).filterBatch(0, 1).count()).to.equal(
      peerIds.length,
    );
  });

  it('rejects more batches than the scheme can encode', () => {
    expect(() => newWorkers(peerIds).filterBatch(0, 65)).to.throw();
  });
});

describe('Workers.add', () => {
  it('de-duplicates repeated peer IDs', () => {
    const id = peerIdEndingIn(3);
    const workers = newWorkers([id, id, id]);
    expect(workers.count()).to.equal(1);
  });

  it('returns the same instance for a repeated peer ID', () => {
    const workers = new Workers(null as any);
    const id = peerIdEndingIn(5);
    expect(workers.add(id)).to.equal(workers.add(id));
  });
});

describe('Workers.getT', () => {
  it('normalizes each worker against the network totals', () => {
    const workers = new Workers(null as any);
    const a = workers.add(peerIdEndingIn(1, 2));
    const b = workers.add(peerIdEndingIn(2, 3));
    a.bytesSent = 300;
    a.chunksRead = 100;
    b.bytesSent = 700;
    b.chunksRead = 900;

    workers.getT();

    // totals: 1000 bytes, 1000 chunks
    expect(a.trafficWeight.toNumber()).to.be.closeTo(
      Math.sqrt(0.3 * 0.1),
      1e-12,
    );
    expect(b.trafficWeight.toNumber()).to.be.closeTo(
      Math.sqrt(0.7 * 0.9),
      1e-12,
    );
  });

  it('REGRESSION: a worker with a tiny share of a large network keeps a non-zero weight', () => {
    // Mirrors production scale: ~1900 workers, one of them carrying ~1e-5 of
    // both byte and chunk traffic. The product of the two shares is ~1e-10.
    const workers = new Workers(null as any);
    const small = workers.add(peerIdEndingIn(9, 4));
    const rest = workers.add(peerIdEndingIn(10, 5));
    small.bytesSent = 545_663_720;
    small.chunksRead = 227;
    rest.bytesSent = 2.392e13 - small.bytesSent;
    rest.chunksRead = 1.865e7 - small.chunksRead;

    workers.getT();

    expect(
      small.trafficWeight.isZero(),
      'small worker was zeroed out',
    ).to.equal(false);
  });
});
