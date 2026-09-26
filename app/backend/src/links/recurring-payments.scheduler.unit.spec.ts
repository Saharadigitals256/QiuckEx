import { EventEmitter2 } from '@nestjs/event-emitter';
import { RecurringPaymentsScheduler } from './recurring-payments.scheduler';
import { RecurringStatus, ExecutionStatus, FrequencyType } from './dto/recurring-payment.dto';

describe('RecurringPaymentsScheduler', () => {
  const link = {
    id: 'link-id',
    username: null,
    destination: `G${'A'.repeat(55)}`,
    amount: 12.5,
    asset: 'USDC',
    asset_issuer: 'GISSUER',
    frequency: FrequencyType.MONTHLY,
    next_execution_date: new Date().toISOString(),
    executed_count: 0,
    status: RecurringStatus.ACTIVE,
    memo: null,
    memo_type: null,
  };
  const execution = {
    id: 'execution-id',
    recurring_link_id: link.id,
    period_number: 1,
    scheduled_at: link.next_execution_date,
    amount: link.amount,
    asset: link.asset,
    status: ExecutionStatus.PENDING,
    retry_count: 0,
    last_retry_at: null,
  };

  let scheduler: RecurringPaymentsScheduler;
  const recurringService = { getLinksDueForExecution: jest.fn() };
  const repository = {
    findExecutionByPeriod: jest.fn(),
    createExecution: jest.fn(),
    claimPendingExecution: jest.fn(),
    resetProcessingExecution: jest.fn(),
  };
  const paymentProcessor = {};
  const eventEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
  const jobQueue = { enqueue: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new RecurringPaymentsScheduler(
      recurringService as never,
      repository as never,
      paymentProcessor as never,
      eventEmitter,
      jobQueue as never,
    );
    recurringService.getLinksDueForExecution.mockResolvedValue([link]);
    repository.findExecutionByPeriod.mockResolvedValue(execution);
    repository.claimPendingExecution.mockResolvedValue(true);
    jobQueue.enqueue.mockResolvedValue('job-id');
  });

  it('claims and enqueues the existing period execution once', async () => {
    await scheduler.checkAndExecutePendingPayments();

    expect(repository.findExecutionByPeriod).toHaveBeenCalledWith(link.id, 1);
    expect(repository.claimPendingExecution).toHaveBeenCalledWith(execution.id);
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips a period already claimed by another scheduler tick', async () => {
    repository.findExecutionByPeriod.mockResolvedValue({
      ...execution,
      status: ExecutionStatus.PROCESSING,
    });

    await scheduler.checkAndExecutePendingPayments();

    expect(repository.claimPendingExecution).not.toHaveBeenCalled();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });
});
