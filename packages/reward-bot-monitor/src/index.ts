import express from "express";
import {
  epochStats,
  rewardCalculatorConfig,
} from "@subsquid-network/rewards-calculator/src";
import { mainnet } from "viem/chains";
import { createPublicClient, http } from "viem";

// force remove verbose reward info
process.env.VERBOSE = "false";

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
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://eth.meowrpc.com"),
  });
  console.log("asdasdasdasd");
  const fromBlock = await publicClient.getBlock({
    blockNumber: _fromBlock,
  });
  console.log(fromBlock);
  const toBlock = await publicClient.getBlock({
    blockNumber: _toBlock,
  });
  console.log(toBlock);
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
    const _epochStats = await epochStats(Number(fromBlock), Number(toBlock));
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
  const { fordefi, clickhouse, ...rest } = rewardCalculatorConfig;
  res.jsonp(rest);
});

app.get("/rewards/:fromBlock/:toBlock", async (req, res) => {
  const { fromBlock, toBlock } = req.params;
  await rewards(fromBlock, toBlock, res);
});

app.get("/rewards/:lastNBlocks", async (req, res) => {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://eth.llamarpc.com"),
  });
  const lastBlock = await publicClient.getBlockNumber();
  console.log(lastBlock);
  const fromBlock = lastBlock - BigInt(req.params.lastNBlocks);
  await rewards(fromBlock.toString(), lastBlock.toString(), res);
});

app.listen(port, () => {
  console.log(`Server listening at http://127.0.0.1:${port}`);
});
