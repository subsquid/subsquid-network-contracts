import {
  Controller,
  Get,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { RewardsCalculatorService } from '../../rewards/calculation/rewards-calculator.service';
import { ContractService } from '../../blockchain/contract.service';
import { TaskContext } from '../../common';

@Controller()
export class PublicController {
  constructor(
    private rewardsCalculatorService: RewardsCalculatorService,
    private contractService: ContractService,
  ) {}

  /**
   * calculate rewards for a specific block range - compatible with old backend
   */
  @Get('rewards/:fromBlock/:toBlock')
  async calculateRewards(
    @Param('fromBlock') fromBlock: string,
    @Param('toBlock') toBlock: string,
  ) {
    const ctx = new TaskContext(
      `public:calculate-rewards:${fromBlock}-${toBlock}`,
    );

    if (!this.isInteger(fromBlock)) {
      throw new HttpException(
        'fromBlock is not an integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!this.isInteger(toBlock)) {
      throw new HttpException(
        'toBlock is not an integer',
        HttpStatus.BAD_REQUEST,
      );
    }

    const fromBlockNum = parseInt(fromBlock, 10);
    const toBlockNum = parseInt(toBlock, 10);

    if (fromBlockNum >= toBlockNum) {
      throw new HttpException(
        'fromBlock should be less than toBlock',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result =
        await this.rewardsCalculatorService.calculateRewardsFormatted(
          ctx,
          fromBlockNum,
          toBlockNum,
          true,
        );

      // Get duration for APR calculation
      const fromBlockInfo = await this.contractService.getL1Block(
        ctx,
        BigInt(fromBlockNum),
      );
      const toBlockInfo = await this.contractService.getL1Block(
        ctx,
        BigInt(toBlockNum),
      );
      const duration = Number(toBlockInfo.timestamp - fromBlockInfo.timestamp);

      const workers = result.workers.map((worker) => ({
        id: worker.id,
        workerReward: this.bn(worker.workerReward),
        stakerReward: this.bn(worker.stakerReward),
        apr: worker.apr.worker_apr,
        traffic: worker.traffic,
        delegation: worker.delegation,
        liveness: worker.liveness,
      }));

      const totalWorkerReward = workers
        .map((worker) => BigInt(worker.workerReward))
        .reduce((a, b) => a + b, 0n);
      const totalStakerReward = workers
        .map((worker) => BigInt(worker.stakerReward))
        .reduce((a, b) => a + b, 0n);

      return {
        totalRewards: {
          worker: totalWorkerReward.toString(),
          staker: totalStakerReward.toString(),
        },
        workers: workers,
      };
    } catch (error: any) {
      ctx.logger.error({ error }, `Failed to calculate rewards`);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * get current APY at latest block - compatible with old backend
   */
  @Get('currentApy')
  async getCurrentApy() {
    return this.getCurrentApyWithBlock(undefined);
  }

  /**
   * get current APY at a specific block - compatible with old backend
   */
  @Get('currentApy/:atBlock')
  async getCurrentApyAtBlock(@Param('atBlock') atBlock: string) {
    return this.getCurrentApyWithBlock(atBlock);
  }

  private async getCurrentApyWithBlock(atBlock?: string) {
    const ctx = new TaskContext(`public:current-apy:${atBlock || 'latest'}`);

    try {
      let blockNumber: bigint;
      let l1BlockNumber: bigint;

      if (!atBlock || !this.isInteger(atBlock)) {
        // get latest block
        const block = await this.contractService.getBlock(ctx);
        blockNumber = block.number;
        l1BlockNumber = BigInt((block as any).l1BlockNumber);
      } else {
        l1BlockNumber = BigInt(atBlock);
        // get first L2 block for this L1 block
        blockNumber =
          await this.contractService.getFirstBlockForL1Block(l1BlockNumber);
      }

      // calculate current APY
      const apy = await this.contractService.getCurrentApy(ctx, blockNumber);

      return {
        blockNumber: blockNumber.toString(),
        l1BlockNumber: l1BlockNumber.toString(),
        apy: apy.toString(),
      };
    } catch (error: any) {
      ctx.logger.error({ error }, `Failed to get current APY`);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * calculate rewards for the last N blocks - compatible with old backend
   */
  @Get('rewards/:lastNBlocks')
  async calculateRewardsForLastNBlocks(
    @Param('lastNBlocks') lastNBlocks: string,
  ) {
    const ctx = new TaskContext(`public:rewards-last-n:${lastNBlocks}`);

    if (!this.isInteger(lastNBlocks)) {
      throw new HttpException(
        'lastNBlocks is not an integer',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const lastBlock = await this.contractService.getL1BlockNumber(ctx);
      const fromBlock = lastBlock - Number(lastNBlocks);

      return this.calculateRewards(fromBlock.toString(), lastBlock.toString());
    } catch (error: any) {
      ctx.logger.error(
        { error },
        `Failed to calculate rewards for last N blocks`,
      );
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private isInteger(value: string): boolean {
    return !isNaN(Number(value)) && Number.isInteger(Number(value));
  }

  private bn(value: string | { toString(): string }): string {
    const strValue = typeof value === 'string' ? value : value.toString();

    if (strValue.includes('e') || strValue.includes('E')) {
      const num = Number(strValue);
      const fixedStr = num.toFixed(0);
      return BigInt(fixedStr).toString();
    }

    const dotIndex = strValue.indexOf('.');
    if (dotIndex === -1) {
      return BigInt(strValue).toString();
    }
    return BigInt(strValue.substring(0, dotIndex)).toString();
  }
}
