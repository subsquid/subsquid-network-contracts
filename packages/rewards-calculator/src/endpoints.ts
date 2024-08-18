import express from "express";
import { epochStats } from "./reward";
import { config, l1Client } from "./config";
import { getBlockNumber } from "./chain";
import { Context } from './logger';

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
  const fromBlock = await l1Client.getBlock({ blockNumber: _fromBlock });
  const toBlock = await l1Client.getBlock({ blockNumber: _toBlock });

  return Number(toBlock.timestamp - fromBlock.timestamp);
};

const bn = (value: { toString(): string }) => BigInt(Math.floor(Number(value.toString())));

function newRequestId() {
  return `gen-${Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)}`;
}

export const NGINX_REQUEST_ID = 'x-request-id';
export const CTX_REQ_ID = 'req_id';


function getContextFromRequest(req: express.Request) {
  const req_id = req.header(NGINX_REQUEST_ID) || newRequestId();

  return new Context({ [CTX_REQ_ID]: req_id })
}

async function rewards(
  ctx: Context,
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
    ctx.logger.trace('getting epoch stats...')
    const _epochStats = await epochStats(
      ctx,
      Number(fromBlock),
      Number(toBlock),
      true,
    );

    ctx.logger.trace('getting epoch duration...')
    const _duration = await duration(BigInt(fromBlock), BigInt(toBlock));
    ctx.logger.trace('done')
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
    ctx.logger.error({
      message: 'failed to calculate rewards',
      err: e
    });

    res.status(500).send(e.message);
  }
}

function maskUrlPath<T = string>(url: T): T {
  if (!url) return url;


  const urlObj = new URL(url as string);
  urlObj.pathname = '...';

  return urlObj.toString() as T;
}

app.get("/config", async (_, res) => {
  const { fordefi, clickhouse, ...rest } = config;

  rest.network.l1RpcUrl = maskUrlPath(rest.network.l1RpcUrl)
  rest.network.l2RpcUrl = maskUrlPath(rest.network.l2RpcUrl)

  res.jsonp(rest);
});

app.get("/rewards/:fromBlock/:toBlock", async (req, res) => {
  const ctx = getContextFromRequest(req)
  const { fromBlock, toBlock } = req.params;

  await rewards(ctx, fromBlock, toBlock, res);
});

app.get("/rewards/:lastNBlocks", async (req, res) => {
  const ctx = getContextFromRequest(req);

  ctx.logger.trace('getting last block number...');

  const lastBlock = await getBlockNumber();
  const fromBlock = lastBlock - Number(req.params.lastNBlocks);

  ctx.logger.trace(`calculating ${fromBlock.toString()} to ${lastBlock.toString()}...`);

  await rewards(ctx, fromBlock.toString(),lastBlock.toString(), res);
});

app.listen(port, () => {
  console.log(`Server listening at http://127.0.0.1:${port}`);
});
