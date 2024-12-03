import express from "express";
import { epochStats } from "./reward";
import { config, l1Client } from "./config";
import { getBlockNumber, currentApy } from "./chain";
import { logger } from "./logger"

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

async function rewards(
  fromBlock: string,
  toBlock: string,
  res: express.Response,
) {
  if (!isInteger(fromBlock)) {
    res.status(400).send("fromBlock is not an integer");
    return;
  }
  if (!isInteger(toBlock)) {
    res.status(400).send("toBlock is not an integer");
    return;
  }
  if (Number(fromBlock) >= Number(toBlock)) {
    res.status(400).send("fromBlock should be less than toBlock");
    return;
  }
  try {
    const _epochStats = await epochStats(
      Number(fromBlock),
      Number(toBlock),
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

    res.jsonp({
      totalRewards: {
        worker: totalWorkerReward,
        staker: totalStakerReward,
      },
      workers: workerStats,
    });
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e.message);
  }
}

app.get("/config", async (_, res) => {
  const { fordefi, clickhouse, ...rest } = config;
  res.jsonp(rest);
});

app.get("/rewards/:fromBlock/:toBlock", async (req, res) => {
  const { fromBlock, toBlock } = req.params;
  await rewards(fromBlock, toBlock, res);
});

app.get("/currentApy/:atBlock", async (req, res) => {
  const { atBlock } = req.params
  let block
  if (!isInteger(atBlock)) {
    block = await getBlockNumber()
  } else {
    block = atBlock
  }
  logger.log(`Block: ${block}`)
  const apy = await currentApy(Number(block));
  res.jsonp({ block, apy})
});


app.get("/rewards/:lastNBlocks", async (req, res) => {
  const lastBlock = await getBlockNumber();
  const fromBlock = lastBlock - Number(req.params.lastNBlocks);
  await rewards(fromBlock.toString(), lastBlock.toString(), res);
});

app.listen(port, () => {
  console.log(`Server listening at http://127.0.0.1:${port}`);
});
