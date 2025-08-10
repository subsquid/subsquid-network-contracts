## subsquid-rewards-backend audit (actionable, code-focused)

- focus: reduce duplication, simplify flows, improve correctness and perf. deep dive: `epochs/stateless-coordinator.service.ts`.

### high-impact fixes

- remove duplicate approval triggering [[memory:5742825]]
  - distribution cron should not also call approvals. keep approvals in approval cron only.
  - diff:
    ```diff
    // file: src/epochs/block-scheduler.service.ts
    @@ async checkDistributionInterval() {
    -      } else {
    -        ctx.logger.info(`👀 I'm not committer - checking for commitments to approve`);
    -        await this.epochProcessor.processExistingApprovals();
    -      }
    +      } else {
    +        // leave approvals to approval cron to avoid double-trigger
    +      }
    ```

- coordinator: use l1 block number consistently and remove hidden deps
  - inject `Web3Service` into `StatelessCoordinatorService`; use `getL1BlockNumber()` for windows/recovery.
  - replace `contractService['web3Service']` access.
  - diff: 0x612033f2990ae87f39993eec84f59051924310893ff5cfd02e0b435521303fa3
  root=0x612033f2990ae87f39993eec84f59051924310893ff5cfd02e0b435521303fa3
    ```diff
    // file: src/epochs/stateless-coordinator.service.ts
    @@ export class StatelessCoordinatorService {
    -  private readonly ACTIVITY_WINDOW_BLOCKS = 50; // check last 50 blocks
    -  private readonly ACTIVITY_TIMEOUT_SECONDS = 300; // 5 minutes
    -  private readonly RECOVERY_BLOCK_THRESHOLD = 100; // ~20 minutes
    +  private readonly ACTIVITY_WINDOW_BLOCKS = this.configService.get('rewards.activityWindowBlocks', 50);
    +  private readonly ACTIVITY_TIMEOUT_SECONDS = this.configService.get('rewards.activityTimeoutSeconds', 300);
    +  private readonly RECOVERY_BLOCK_THRESHOLD = this.configService.get('rewards.recoveryBlockThreshold', 100);
    @@ constructor(
    -    private contractService: ContractService,
    -    private configService: ConfigService,
    -  ) {}
    +    private contractService: ContractService,
    +    private configService: ConfigService,
    +    private web3Service: Web3Service,
    +  ) {}
    @@ async isCurrentCommitter(...) {
    -      const currentBlock = await this.contractService.getCurrentBlockNumber();
    +      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
    @@ async shouldActivateRecovery() {
    -      const currentL1Block = await this.contractService['web3Service'].getL1BlockNumber(ctx);
    +      const currentL1Block = await this.web3Service.getL1BlockNumber(ctx);
    ```

- coordinator: fix active distribution detection
  - sort by time ascending and ensure non-decreasing batch ids. tolerate short repeats.
  - replace method:
    ```ts
    // file: src/epochs/stateless-coordinator.service.ts
    private isDistributionProgressing(events: any[]): boolean {
      if (events.length < 2) return true;
      const chronological = [...events].sort((a, b) => a.blockTimestamp - b.blockTimestamp);
      let last = chronological[0].batchIndex ?? 0;
      let repeats = 0;
      for (let i = 1; i < chronological.length; i++) {
        const cur = chronological[i].batchIndex ?? 0;
        if (cur < last) return false; // regression => not progressing
        if (cur === last) repeats++; else repeats = 0;
        last = cur;
      }
      return repeats <= 3;
    }
    ```

- distribution: make failed preflight non-fatal
  - do not throw when a batch’s simulation fails; log failed batch and continue.
  - diff:
    ```diff
    // file: src/rewards/distribution/distribution.service.ts (inside distributeBatches)
    -            if (!gasSimulation.success) {
    -              batchCtx.logger.error(
    -                `❌ [${sessionId}] Pre-flight simulation failed for batch ${batchNumber}: ${gasSimulation.error}`,
    -              );
    -
    -              if (leaf.recipients.length > 1) {
    -                batchCtx.logger.warn(
    -                  `🔄 [${sessionId}] Attempting to split failing batch ${batchNumber} into smaller chunks...`,
    -                );
    -                const chunkLogs = await this.distributeBatchInChunks(...);
    -                transactionLogs.push(...chunkLogs);
    -                continue;
    -              } else {
    -                const failedLog: TransactionLog = { /* ... */ };
    -                transactionLogs.push(failedLog);
    -                throw new Error(
    -                  `Single worker batch failed simulation: ${gasSimulation.error}`,
    -                );
    -              }
    -            }
    +            if (!gasSimulation.success) {
    +              batchCtx.logger.error(`preflight failed for batch ${batchNumber}: ${gasSimulation.error}`);
    +              transactionLogs.push({
    +                type: 'distribute', hash: 'failed', blockNumber: 0, gasUsed: 0n, gasPrice: 0n,
    +                batchNumber, workerCount: leaf.recipients.length, duration: 0, status: 'failed',
    +                error: gasSimulation.error,
    +              });
    +              continue;
    +            }
    ```

### coordinator notes (line-by-line)

- constants: move to config keys `rewards.activityWindowBlocks`, `rewards.activityTimeoutSeconds`, `rewards.recoveryBlockThreshold`.
- commits window math: use l1 blocks everywhere for consistency with confirmations.
- `getBotAddress()`: validate key like in `DistributionService` (0x-prefix, length 66), and throw early.
- `checkCommitEligibility()`: avoid calling `isCurrentCommitter()` again when caller already knows; accept an optional boolean to skip extra rpc.
- approvals scan: parallelize `hasApprovedCommitment()` calls:
  ```ts
  const statuses = await Promise.all(pendingCommitments.map(c =>
    this.contractService.hasApprovedCommitment(c.fromBlock, c.toBlock, botAddress)
  ));
  ```
- `analyzeDistributionPattern()`: sort ascending before passing to `isDistributionProgressing()` to keep order consistent.

### reuse and simplification

- centralize viem client and wallet
  - today `DistributionService` builds its own clients; `Web3Service` already handles clients. move wallet/client creation to `Web3Service` (or new `WalletService`). inject where needed.

- abstract transaction sender
  - define `TxSender` interface; implement `ViemTxSender` and `FordefiTxSender`. pick via config. use in `DistributionService` and `ContractService`.

- factor reward formatting
  - extract shared util to format worker rows for s3/admin; reuse in both places.

- remove apr calc duplication
  - move `calculateBaseAPR` and `calculateStakeDiscountFactor` to a shared helper used by admin route and any other consumer.

- config normalization
  - align keys under `blockchain.network.*` and `rewards.*`; remove mixed `networkName` vs `blockchain.network.name` vs `blockchain.network.networkName`.

### performance

- approvals scan concurrency (above).
- cache worker-id mapping per epoch in `RewardsCalculatorService` to avoid repeated lookups in `filterWorkersBatch()`.
- avoid double ClickHouse pass in `distributeEpochRewards()` by deriving the formatted view from the detailed result instead of calling both detailed and formatted.

### safety

- validate private keys consistently (prefix/length) where used.
- avoid `service['internal']` access; inject dependencies explicitly.
- keep s3 failures non-fatal but log prominently (already done); ensure metrics emitted.

### tests to add

- coordinator progression detection (increasing, repeating, regressing sequences).
- cron separation: approvals only on approval cron; no active approvals in distribution cron.
- e2e on anvil: commit→approve→distribute with simulated failing batch preflight; ensure remaining batches continue.
