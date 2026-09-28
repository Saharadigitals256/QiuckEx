import { Injectable, Logger } from '@nestjs/common';
import { ReceiptsService } from '../../receipts/receipts.service';
import { CancellationToken, Job, JobHandler } from '../types';
import { DerivedRecordRepairPayload } from '../types/job-payloads.types';
import { PermanentJobError } from './webhook-delivery.handler';

@Injectable()
export class DerivedRecordRepairHandler implements JobHandler<DerivedRecordRepairPayload> {
  private readonly logger = new Logger(DerivedRecordRepairHandler.name);

  constructor(private readonly receipts: ReceiptsService) {}

  async execute(
    job: Job<DerivedRecordRepairPayload>,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    for (const txHash of job.payload.transactionHashes) {
      cancellationToken.throwIfCancelled();
      await this.receipts.repairTransactions([txHash]);
    }
    this.logger.log(`Repaired ${job.payload.transactionHashes.length} transaction receipt(s)`);
  }

  async validate(payload: DerivedRecordRepairPayload): Promise<void> {
    if (
      !payload ||
      !Array.isArray(payload.transactionHashes) ||
      payload.transactionHashes.length < 1 ||
      payload.transactionHashes.length > 100 ||
      payload.transactionHashes.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))
    ) {
      throw new PermanentJobError('transactionHashes must contain 1 to 100 64-character transaction hashes');
    }
  }

  async onFailure(job: Job<DerivedRecordRepairPayload>, error: Error): Promise<void> {
    this.logger.error(`Derived record repair job ${job.id} failed: ${error.message}`, error.stack);
  }
}
