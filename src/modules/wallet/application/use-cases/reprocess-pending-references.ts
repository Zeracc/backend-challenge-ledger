import type { Clock } from '../../../../shared/application/ports/clock.js';
import { PendingReferenceRetryPolicy } from '../pending-reference-retry-policy.js';
import type {
  PendingReferenceProcessor,
  ReprocessPendingReferencesResult,
} from '../ports/wager-transaction.processor.js';

export class ReprocessPendingReferencesUseCase {
  public constructor(
    private readonly processor: PendingReferenceProcessor,
    private readonly clock: Clock,
    private readonly retryPolicy = new PendingReferenceRetryPolicy(),
  ) {}

  public async execute(): Promise<ReprocessPendingReferencesResult> {
    return this.processor.reprocessDue({
      occurredAt: this.clock.now(),
      batchSize: this.retryPolicy.batchSize,
      maximumAttempts: this.retryPolicy.maximumAttempts,
      baseDelayMs: this.retryPolicy.baseDelayMs,
      maximumDelayMs: this.retryPolicy.maximumDelayMs,
    });
  }
}
