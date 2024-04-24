import { NetworkStatsEntry } from "./clickhouseClient";
import { getWorkerId } from "./chain";
import { QueryLog, validateSignatures } from "./signatureVerification";
import { config } from "./config";

import Decimal from "decimal.js";
Decimal.set({ precision: 28, minE: -9 });

export class Worker {
  private contractId: bigint | undefined;
  public networkStats!: NetworkStatsEntry;
  public bytesSent = 0;
  public chunksRead = 0;
  public trafficWeight = new Decimal(0);
  public dTraffic = new Decimal(0);
  public stake = new Decimal(0);
  public totalStake = new Decimal(0);
  public livenessCoefficient = new Decimal(0);
  public bond = new Decimal(0);
  public actualYield = new Decimal(0);
  public workerReward!: Decimal;
  public stakerReward!: Decimal;
  public dTenure!: Decimal;
  public requestsProcessed = 0n;
  public totalRequests = 0;

  constructor(public peerId: string) {}

  public setContractId(contractId: bigint) {
    this.contractId = contractId;
  }

  public async processQuery(query: QueryLog) {
    this.totalRequests++;
    if (!(await validateSignatures(query))) return false;
    this.bytesSent += query.output_size;
    this.chunksRead += query.num_read_chunks;
    this.requestsProcessed++;
    return true;
  }

  public async getId() {
    if (this.contractId) {
      return this.contractId;
    }
    this.contractId = await getWorkerId(this.peerId);
    return this.contractId;
  }

  public async calculateT(totalBytesSent: number, totalChunksRead: number) {
    const { bytesSent, chunksRead } = this.normalizeTraffic(
      totalBytesSent,
      totalChunksRead,
    );
    this.trafficWeight = Decimal.sqrt(bytesSent.mul(chunksRead));
  }

  public async calculateDTraffic(totalSupply: Decimal) {
    const supplyRatio = this.stake.add(this.bond).div(totalSupply);
    this.dTraffic = Decimal.min(
      new Decimal(1),
      this.trafficWeight.div(supplyRatio).pow(config.dTrafficAlpha),
    );
  }

  public async calculateLiveness(networkStats: NetworkStatsEntry) {
    this.networkStats = networkStats;
    if (!networkStats) return;
    const { livenessFactor } = networkStats;
    if (livenessFactor < 0.8) {
      this.livenessCoefficient = new Decimal(0);
    } else if (livenessFactor < 0.9) {
      this.livenessCoefficient = new Decimal(9).mul(livenessFactor).sub(7.2);
    } else if (livenessFactor < 0.95) {
      this.livenessCoefficient = new Decimal(2).mul(livenessFactor).sub(0.9);
    } else {
      this.livenessCoefficient = new Decimal(1);
    }
  }

  public async calculateDTenure(historicalLiveness: number[]) {
    const LIVENESS_THRESHOLD = 0.9;
    const liveEpochs = new Decimal(
      historicalLiveness.filter(
        (liveness) => liveness >= LIVENESS_THRESHOLD,
      ).length,
    );
    this.dTenure = new Decimal(0.5).add(
      Decimal.floor(liveEpochs.div(2).add(0.05)).mul(0.1),
    );
  }

  public async getRewards(rMax: Decimal) {
    this.actualYield = rMax
      .mul(this.livenessCoefficient)
      .mul(this.dTraffic)
      .mul(this.dTenure);

    this.workerReward = this.actualYield.mul(this.bond.add(this.stake.div(2)));

    this.stakerReward = this.actualYield.mul(this.stake).div(2);
  }

  public stakeWeight(stakeSum: Decimal) {
    return stakeSum.eq(0) ? new Decimal(0) : this.stake.div(stakeSum);
  }

  public apr(epochDuration: number, year: number) {
    const bond = new Decimal(this.bond.toString());
    const workerReward = new Decimal(this.workerReward.toString());
    const stakerReward = new Decimal(this.stakerReward.toString());
    const duration = new Decimal(year).div(epochDuration);

    return {
      worker_apr: workerReward.div(bond).mul(duration).toFixed(),
      delegator_apr: stakerReward.div(this.totalStake).mul(duration).toFixed(),
    };
  }

  private normalizeTraffic(totalBytesSent: number, totalChunksRead: number) {
    return {
      bytesSent: new Decimal(this.bytesSent).div(totalBytesSent),
      chunksRead: new Decimal(this.chunksRead).div(totalChunksRead),
    };
  }
}
