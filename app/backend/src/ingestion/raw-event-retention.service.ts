import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UnparsedSorobanEventRepository } from './unparsed-soroban-event.repository';

@Injectable()
export class RawEventRetentionService {
  private readonly logger = new Logger(RawEventRetentionService.name);
  private readonly retentionDays = Math.max(
    1,
    Number(process.env.SOROBAN_RAW_EVENT_RETENTION_DAYS ?? 90),
  );

  constructor(private readonly events: UnparsedSorobanEventRepository) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'UTC' })
  async archiveExpiredEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const archived = await this.events.archiveReplayedBefore(cutoff);
    this.logger.log(`Archived ${archived} replayed raw Soroban event(s) before ${cutoff.toISOString()}`);
    return archived;
  }
}
