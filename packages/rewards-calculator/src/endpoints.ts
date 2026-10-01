import express from 'express';
import { currentApy, getFirstBlockForL1Block, getL1BlockNumber } from './chain';
import { config, l1Client, publicClient } from './config';
import { logger } from './logger';
import { epochStats } from './reward';
import { withCache } from './utils';

const app = express();
const port = process.env.PORT ?? 3000;

// @ts-ignore
BigInt.prototype.toJSON = function () {
  return this.toString();
};

function isInteger(value: string): boolean {
  return !isNaN(Number(value)) && Number.isInteger(Number(value));
}

const duration = async (_fromBlock: bigint, _toBlock: bigint) => {
  const fromBlock = await l1Client.getBlock({
    blockNumber: _fromBlock,
  });
  const toBlock = await l1Client.getBlock({
    blockNumber: _toBlock,
  });
  return Number(toBlock.timestamp - fromBlock.timestamp);
};

const bn = (value: { toString(): string }) =>
  BigInt(Math.floor(Number(value.toString())));

async function computeRewards(fromBlock: number, toBlock: number) {
  const _epochStats = await epochStats(
    fromBlock,
    toBlock,
    config.skipSignatureValidation,
  );
  const _duration = await duration(BigInt(fromBlock), BigInt(toBlock));
  const workerStats = _epochStats.map((worker) => ({
    id: worker.peerId,
    workerReward: bn(worker.workerReward),
    stakerReward: bn(worker.stakerReward),
    apr: worker.apr(_duration, 365 * 24 * 60 * 60),
    traffic: {
      bytesSent: worker.bytesSent,
      chunksRead: worker.chunksRead,
      trafficWeight: worker.trafficWeight.toNumber(),
      dTraffic: worker.dTraffic.toNumber(),
      validRequests: worker.requestsProcessed,
      totalRequests: worker.totalRequests,
      requestErrorRate: 1 - worker.requestsProcessed / worker.totalRequests,
    },
    delegation: {
      totalDelegated: bn(worker.totalStake),
      effectiveStake: bn(worker.stake),
    },
    liveness: {
      livenessCoefficient: worker.livenessCoefficient.toNumber(),
      tenure: worker.dTenure.toNumber(),
    },
  }));
  const totalWorkerReward = workerStats
    .map((worker) => worker.workerReward)
    .reduce((a, b) => a + bn(b), 0n);
  const totalStakerReward = workerStats
    .map((worker) => worker.stakerReward)
    .reduce((a, b) => a + bn(b), 0n);

  return {
    totalRewards: {
      worker: totalWorkerReward,
      staker: totalStakerReward,
    },
    workers: workerStats,
  };
}

// Clients retry the same window; one ClickHouse scan per window is enough.
const cachedRewards = withCache(computeRewards, {
  ttl: config.rewardsCacheTtl,
  maxEntries: 16,
});

async function rewards(
  fromBlock: string,
  toBlock: string,
  res: express.Response,
) {
  if (!isInteger(fromBlock)) {
    res.status(400).send('fromBlock is not an integer');
    return;
  }
  if (!isInteger(toBlock)) {
    res.status(400).send('toBlock is not an integer');
    return;
  }
  if (Number(fromBlock) >= Number(toBlock)) {
    res.status(400).send('fromBlock should be less than toBlock');
    return;
  }
  try {
    res.jsonp(await cachedRewards(Number(fromBlock), Number(toBlock)));
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e.message);
  }
}

app.get('/config', async (_, res) => {
  const { fordefi, clickhouse, ...rest } = config;
  res.jsonp(rest);
});

app.get('/rewards/:fromBlock/:toBlock', async (req, res) => {
  const { fromBlock, toBlock } = req.params;
  await rewards(fromBlock, toBlock, res);
});

app.get('/currentApy/:atBlock?', async (req, res) => {
  try {
    const { atBlock } = req.params;
    let blockNumber: bigint;
    let l1BlockNumber: bigint;
    if (!atBlock || !isInteger(atBlock)) {
      let block = await publicClient.getBlock();
      blockNumber = block.number;
      l1BlockNumber = BigInt((block as any).l1BlockNumber);
    } else {
      l1BlockNumber = BigInt(atBlock);
      blockNumber = await getFirstBlockForL1Block(l1BlockNumber);
    }
    const apy = await currentApy(blockNumber);
    res.jsonp({ blockNumber, l1BlockNumber, apy });
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e.message);
  }
});

app.get('/rewards/:lastNBlocks', async (req, res) => {
  const lastBlock = await getL1BlockNumber();
  const fromBlock = lastBlock - Number(req.params.lastNBlocks);
  await rewards(fromBlock.toString(), lastBlock.toString(), res);
});

app.listen(port, () => {
  console.log(`Server listening at http://127.0.0.1:${port}`);
});
