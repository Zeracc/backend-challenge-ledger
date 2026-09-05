import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references.js';

const SCHEDULER_INTERVAL_MS = 5_000;

@Injectable()
export class PendingReferenceScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private readonly logger = new Logger(PendingReferenceScheduler.name);

  public constructor(
    private readonly reprocessPendingReferences: ReprocessPendingReferencesUseCase,
  ) {}

  public onModuleInit(): void {
    this.timer = setInterval(() => this.trigger(), SCHEDULER_INTERVAL_MS);
    this.timer.unref?.();
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    await this.running;
  }

  private trigger(): void {
    if (this.stopping || this.running !== undefined) return;
    this.running = this.reprocessPendingReferences
      .execute()
      .then(() => undefined)
      .catch(() => {
        this.logger.error({
          event: 'pending_reference_batch_failed',
          code: 'REFERENCE_REPROCESSING_FAILED',
        });
      })
      .finally(() => {
        this.running = undefined;
      });
  }
}
