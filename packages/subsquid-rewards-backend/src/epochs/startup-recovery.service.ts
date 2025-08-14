import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DistributionRecoveryService } from '../rewards/distribution/distribution-recovery.service';
import { ContractService } from '../blockchain/contract.service';
import { TaskContext } from '../common';

@Injectable()
export class StartupRecoveryService implements OnModuleInit {
  private readonly enableRecoveryCheck: boolean;

  constructor(
    private configService: ConfigService,
    private contractService: ContractService,
    private recoveryService: DistributionRecoveryService,
  ) {
    this.enableRecoveryCheck = this.configService.get(
      'rewards.enableStartupRecoveryCheck',
      true,
    );
  }

  async onModuleInit() {
    if (!this.enableRecoveryCheck) {
      return;
    }

    const ctx = new TaskContext('startup:recovery-check');

    try {
      ctx.logger.info(
        '🔍 Checking for interrupted distributions on startup...',
      );

      let lastBlockRewarded: number;
      try {
        lastBlockRewarded =
          await this.contractService.getLastBlockRewarded(ctx);
      } catch (error: any) {
        if (
          error.message?.includes('ContractFunctionExecutionError') ||
          error.message?.includes('lastBlockRewarded') ||
          error.cause?.message?.includes('reverted')
        ) {
          ctx.logger.warn(
            'Contract does not support lastBlockRewarded function or is not properly deployed. Skipping recovery check.',
          );
          ctx.logger.warn(
            `Contract address: ${this.configService.get('blockchain.contracts.rewardsDistribution')}`,
          );
          ctx.logger.warn(
            'This might be a new deployment or the contract ABI might be outdated.',
          );
          ctx.logger.debug({ error: error.message }, 'Full error details');
          return;
        }
        throw error;
      }

      if (lastBlockRewarded === 0) {
        ctx.logger.info(
          '📊 No previous distributions found (lastBlockRewarded = 0)',
        );
        return;
      }

      ctx.logger.info(`📊 Last block rewarded: ${lastBlockRewarded}`);

      // check if there's a last commitment key
      let lastCommitmentKey: string;
      try {
        lastCommitmentKey =
          await this.contractService.getLastCommitmentKey(ctx);
        ctx.logger.info(`🔑 Last commitment key: ${lastCommitmentKey}`);
      } catch (error) {
        ctx.logger.debug(
          'Could not fetch lastCommitmentKey - might be using older contract',
        );
        lastCommitmentKey =
          '0x0000000000000000000000000000000000000000000000000000000000000000';
      }

      // if we have a last commitment key, check its status
      if (
        lastCommitmentKey !==
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) {
        try {
          // decode the commitment key to get block range
          // the key is keccak256(abi.encode(fromBlock, toBlock))
          // we need to check pending distributions to find the range
          const pendingInfo =
            await this.recoveryService.checkPendingDistributions(ctx);

          if (pendingInfo.lastCommitment) {
            const {
              fromBlock,
              toBlock,
              status,
              processedBatches,
              totalBatches,
            } = pendingInfo.lastCommitment;

            if (status === 1) {
              // ACTIVE
              ctx.logger.warn(
                `⚠️ Found active commitment for blocks ${fromBlock}-${toBlock}: ${processedBatches}/${totalBatches} batches processed`,
              );
              ctx.logger.warn(
                '💡 This distribution needs to be resumed. Use the /admin/distribute endpoint.',
              );
            } else if (status === 2) {
              // COMPLETED
              ctx.logger.info(
                `✅ Last commitment (blocks ${fromBlock}-${toBlock}) is completed`,
              );
            }
          }
        } catch (error) {
          ctx.logger.debug('Error checking last commitment status:', error);
        }
      }

      // check for other pending distributions
      const pendingInfo =
        await this.recoveryService.checkPendingDistributions(ctx);

      if (pendingInfo.pendingRanges.length > 0) {
        ctx.logger.warn(
          `⚠️ Found ${pendingInfo.pendingRanges.length} pending distribution ranges:`,
        );

        for (const range of pendingInfo.pendingRanges) {
          ctx.logger.warn(
            `   - Blocks ${range.fromBlock}-${range.toBlock}: ${range.status}`,
          );
        }

        ctx.logger.warn(
          '💡 Use the /admin/distribute endpoint to resume these distributions',
        );
      } else if (
        !pendingInfo.lastCommitment ||
        pendingInfo.lastCommitment.status === 2
      ) {
        ctx.logger.info('✅ No interrupted distributions found');
      }

      const currentL1Block =
        await this.contractService['web3Service'].getL1BlockNumber(ctx);
      const epochLength = await this.contractService.getEpochLength(ctx);
      const blocksSinceLastReward = currentL1Block - lastBlockRewarded;

      if (blocksSinceLastReward > epochLength) {
        const missedEpochs = Math.floor(blocksSinceLastReward / epochLength);
        ctx.logger.warn(
          `⚠️ ${missedEpochs} epochs have passed since last distribution (${blocksSinceLastReward} blocks)`,
        );
        ctx.logger.warn(
          `💡 Next distribution should start from block ${lastBlockRewarded + 1}`,
        );
      } else {
        ctx.logger.info(`✅ ${blocksSinceLastReward} blocks since last reward`);
      }
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to complete startup recovery check');
    }
  }
}
