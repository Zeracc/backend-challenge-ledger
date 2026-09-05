import {
  Injectable,
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

  public constructor(
    private readonly reprocessPendingReferences: ReprocessPendingReferencesUseCase,
  ) {}

  public onModuleInit(): void {
    this.timer = setInterval(() => this.trigger(), SCHEDULER_INTERVAL_MS);
    this.timer.unref?.();
  }

  public onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
  }

  private trigger(): void {
    void this.reprocessPendingReferences.execute().catch(() => undefined);
  }
}
