import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RecurringPaymentsService } from './recurring-payments.service';
import { RecurringPaymentsRepository, DbRecurringPaymentLink, DbRecurringPaymentExecution } from './recurring-payments.repository';
import { RecurringPaymentProcessor } from '../stellar/recurring-payment-processor';
import { JobQueueService } from '../job-queue/job-queue.service';
import { JobType } from '../job-queue/types';
import { RecurringPaymentPayload } from '../job-queue/types/job-payloads.types';

@Injectable()
export class RecurringPaymentsScheduler implements OnModuleInit {
  private readonly logger = new Logger(RecurringPaymentsScheduler.name);
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly notificationHoursBefore: number;

  constructor(
    private readonly schedulerService: RecurringPaymentsService,
    private readonly repository: RecurringPaymentsRepository,
    private readonly paymentProcessor: RecurringPaymentProcessor,
    private readonly eventEmitter: EventEmitter2,
    private readonly jobQueueService: JobQueueService,
  ) {
    this.maxRetries = parseInt(process.env.RECURRING_PAYMENT_MAX_RETRY || '3');
    this.retryBackoffMs = parseInt(process.env.RECURRING_PAYMENT_RETRY_BACKOFF_MS || '60000');
    this.notificationHoursBefore = parseInt(process.env.RECURRING_PAYMENT_NOTIFICATION_HOURS_BEFORE || '24');
  }

  onModuleInit(): void {
    this.logger.log('Recurring payments scheduler initialized');
    this.logger.log(`Configuration: maxRetries=${this.maxRetries}, retryBackoffMs=${this.retryBackoffMs}ms, notificationHoursBefore=${this.notificationHoursBefore}h`);
  }

  // ---------------------------------------------------------------------------
  // Cron Jobs
  // ---------------------------------------------------------------------------

  /**
   * Check for pending payments every minute
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkAndExecutePendingPayments(): Promise<void> {
    try {
      this.logger.debug('Checking for pending recurring payments...');

      const linksDue = await this.schedulerService.getLinksDueForExecution();

      if (linksDue.length === 0) {
        this.logger.debug('No recurring payments due for execution');
        return;
      }

      this.logger.log(`Found ${linksDue.length} recurring payment(s) due for execution`);

      // Process sequentially and continue when one link fails to enqueue.
      for (const link of linksDue) {
        try {
          await this.processRecurringPayment(link);
        } catch (error) {
          this.logger.error(
            `Error processing recurring payment ${link.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error in scheduled payment execution: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  /**
   * Send payment due notifications 24 hours before scheduled date
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendUpcomingPaymentNotifications(): Promise<void> {
    try {
      this.logger.debug('Checking for upcoming payment notifications...');

      // This would query for payments scheduled in the next 24 hours
      // Implementation depends on specific notification requirements
      // For now, we'll skip detailed implementation
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error sending notifications: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Payment Processing Logic
  // ---------------------------------------------------------------------------

  private async processRecurringPayment(link: DbRecurringPaymentLink): Promise<void> {
    const linkId = link.id;
    const periodNumber = link.executed_count + 1;
    let execution = await this.repository.findExecutionByPeriod(linkId, periodNumber);

    if (!execution) {
      try {
        execution = await this.repository.createExecution({
          recurringLinkId: linkId,
          periodNumber,
          scheduledAt: new Date(link.next_execution_date),
          amount: link.amount,
          asset: link.asset,
        });
        this.logger.log(`Created execution record: ${execution.id} for period ${periodNumber}`);
      } catch (error) {
        // Another scheduler instance may have created this unique period first.
        execution = await this.repository.findExecutionByPeriod(linkId, periodNumber);
        if (!execution) throw error;
      }
    }

    try {
      this.logger.log(`Processing recurring payment for link: ${linkId}`);

      const nextPeriodNumber = link.executed_count + 1;
      const existingExecutions = await this.repository.findExecutionsByLinkId(linkId);
      const alreadyScheduled = existingExecutions.some(
        (execution) => execution.period_number === nextPeriodNumber && ['pending', 'success', 'failed'].includes(execution.status),
      );

      if (alreadyScheduled) {
        this.logger.debug(`Recurring payment execution for link ${linkId} period ${nextPeriodNumber} already exists; skipping duplicate.`);
        return;
      }

      const execution = await this.repository.createExecution({
        recurringLinkId: linkId,
        periodNumber: nextPeriodNumber,
        scheduledAt: new Date(link.next_execution_date),
        amount: link.amount,
        asset: link.asset,
      });

      this.logger.log(`Created execution record: ${execution.id} for period ${nextPeriodNumber}`);
      await this.executeSinglePayment(link, execution);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error processing recurring payment ${linkId}: ${errorMessage}`, error instanceof Error ? error.stack : undefined);

      await this.schedulerService.markPaymentFailure(
        linkId,
        errorMessage,
        0,
      );
    }
    if (!(await this.repository.claimPendingExecution(execution.id))) return;

    await this.executeSinglePayment(link, execution);
  }

  private async executeSinglePayment(
    link: DbRecurringPaymentLink,
    execution: DbRecurringPaymentExecution,
  ): Promise<void> {
    const executionId = execution.id;

    try {
      this.logger.log(`Enqueuing payment job for execution: ${executionId}`);

      // Determine recipient
      const recipientAddress = link.destination || (await this.resolveUsernameToAddress(link.username!));

      if (!recipientAddress) {
        throw new Error('Could not resolve recipient address');
      }

      // Enqueue payment job via JobQueueService
      const payload: RecurringPaymentPayload = {
        recurringLinkId: link.id,
        executionId: executionId,
        recipientAddress,
        amount: link.amount.toString(),
        asset: link.asset,
        assetIssuer: link.asset_issuer || undefined,
        memo: link.memo || undefined,
        memoType: link.memo_type || undefined,
      };

      const jobId = await this.jobQueueService.enqueue(
        JobType.RECURRING_PAYMENT,
        payload,
        `${execution.id}:${execution.retry_count}`,
      );

      this.logger.log(`Payment job enqueued: ${jobId} for execution: ${executionId}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to enqueue payment job: ${errorMessage}`, error instanceof Error ? error.stack : undefined);

      const currentRetryCount = execution.retry_count + 1;

      await this.schedulerService.markPaymentFailure(
        execution.id,
        errorMessage,
        currentRetryCount,
      );

      await this.notifyUser(
        link,
        execution,
        'failed',
        undefined,
        errorMessage,
        currentRetryCount,
        currentRetryCount >= this.maxRetries,
      );

      // Re-throw to let caller handle
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Notification Helpers
  // ---------------------------------------------------------------------------

  private async notifyUser(
    link: DbRecurringPaymentLink,
    execution: DbRecurringPaymentExecution,
    type: 'success' | 'failed' | 'due',
    transactionHash?: string,
    failureReason?: string,
    retryCount = 0,
    permanent = false,
  ): Promise<void> {
    try {
      const eventType = type === 'success' ? 'recurring.payment.executed' : 'recurring.payment.failed';
      const recipientKeys = new Set<string>();
      if (link.payer_public_key) recipientKeys.add(link.payer_public_key);
      if (link.destination && (type === 'success' || permanent)) recipientKeys.add(link.destination);

      for (const recipientPublicKey of recipientKeys) {
        this.eventEmitter.emit('recurring.payment.notification', {
          eventType,
          eventId: `${execution.id}:${eventType}:${recipientPublicKey}`,
          recipientPublicKey,
          linkId: link.id,
          executionId: execution.id,
          amount: link.amount,
          asset: link.asset,
          periodNumber: execution.period_number,
          transactionHash,
          failureReason,
          retryCount,
          permanent,
          occurredAt: new Date().toISOString(),
        });
      }

      this.logger.debug(`Emitted recurring notification: ${eventType}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error emitting notification: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async resolveUsernameToAddress(_username: string): Promise<string | null> {
    // TODO: Integrate with usernames module to resolve username to Stellar address
    // For now, return null - in production this would query the usernames table
    this.logger.warn('Username resolution not yet implemented');
    return null;
  }
}
