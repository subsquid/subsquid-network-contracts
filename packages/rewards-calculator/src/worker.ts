import { NetworkStatsEntry } from "./clickhouseClient";
import { getWorkerId } from "./chain";
import { QueryLog, validateSignatures } from "./signatureVerification";
import { config } from "./config";

import Decimal from 'decimal.js';
Decimal.set({ precision: 9 })

const PRECISION = 1_000_000_000n;

export class Worker {
  private contractId: bigint | undefined;
  public networkStats: NetworkStatsEntry;
  public bytesSent = 0;
  public chunksRead = 0;
  public trafficWeight = 0;
  public dTraffic = 0;
  public stake = 0n;
  public livenessCoefficient = 0;
  public bond = 0n;
  public actualYield = 0;
  public workerReward: bigint;
  public stakerReward: bigint;
  public dTenure: number;
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
    this.trafficWeight = Math.sqrt(bytesSent * chunksRead);
  }

  public async calculateDTraffic(totalSupply: bigint, totalTraffic: number) {
    const supplyRatio =
      Number(((this.stake + this.bond) * PRECISION) / totalSupply) /
      Number(PRECISION);
    this.dTraffic = Math.min(
      1,
      (this.trafficWeight / totalTraffic / supplyRatio) ** config.dTrafficAlpha,
    );
  }

  public async calculateLiveness(networkStats: NetworkStatsEntry) {
    this.networkStats = networkStats;
    if (!networkStats) return;
    const { livenessFactor } = networkStats;
    if (livenessFactor < 0.8) {
      this.livenessCoefficient = 0;
    } else if (livenessFactor < 0.9) {
      this.livenessCoefficient = 9 * livenessFactor - 7.2;
    } else if (livenessFactor < 0.95) {
      this.livenessCoefficient = 2 * livenessFactor - 0.9;
    } else {
      this.livenessCoefficient = 1;
    }
  }

  public async calculateDTenure(historicalLiveness: number[]) {
    const LIVENESS_THRESHOLD = 0.9;
    const liveEpochs = historicalLiveness.filter(
      (liveness) => liveness >= LIVENESS_THRESHOLD,
    ).length;
    this.dTenure = 0.5 + Math.floor(liveEpochs / 2 + 0.05) * 0.1;
  }

  public async getRewards(rMax: number) {
    this.actualYield = rMax * this.livenessCoefficient * this.dTraffic * this.dTenure;

    const preciseR = BigInt(Math.floor(this.actualYield * Number(PRECISION)));
    this.workerReward = (preciseR * (this.bond + this.stake / 2n)) / PRECISION;
    this.stakerReward = (preciseR * this.stake) / 2n / PRECISION;
  }

  public stakeWeight(stakeSum: bigint) {
    return Number(stakeSum === 0n ? 0n : this.stake / stakeSum);
  }

  public apr(epochDuration: number, year: number) {
    const bond = new Decimal(this.bond.toString());
    const workerReward = new Decimal(this.workerReward.toString());
    const stakerReward = new Decimal(this.workerReward.toString());
    const durtation = new Decimal(year).div(epochDuration);

    return {
      workerAPR: workerReward.div(bond).mul(durtation).toFixed(9),
      delegatorAPR: stakerReward.div(bond).mul(durtation).toFixed(9),
    }
  }

  private normalizeTraffic(totalBytesSent: number, totalChunksRead: number) {
    return {
      bytesSent: this.bytesSent / totalBytesSent,
      chunksRead: this.chunksRead / totalChunksRead,
    };
  }
}
