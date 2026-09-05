import type {
  PendingReferenceProcessor,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  ReprocessPendingReferencesCommand,
  ReprocessPendingReferencesResult,
  WagerTransactionProcessor,
} from '../../application/ports/wager-transaction.processor.js';
import type { OperationalTelemetry } from './operational.telemetry.js';
import { safelyObserve } from './operational.telemetry.js';

export class ObservedWagerProcessor
  implements WagerTransactionProcessor, PendingReferenceProcessor
{
  public constructor(
    private readonly inner: WagerTransactionProcessor &
      PendingReferenceProcessor,
    private readonly telemetry: OperationalTelemetry,
  ) {}
  public async processAtomically(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const started = performance.now();
    try {
      const result = await this.inner.processAtomically(command);
      safelyObserve(() =>
        this.telemetry.completed(
          command,
          result,
          (performance.now() - started) / 1000,
        ),
      );
      return result;
    } catch (error) {
      safelyObserve(() =>
        this.telemetry.failed(
          command,
          error,
          (performance.now() - started) / 1000,
        ),
      );
      throw error;
    }
  }
  public async reprocessDue(
    command: ReprocessPendingReferencesCommand,
  ): Promise<ReprocessPendingReferencesResult> {
    try {
      const result = await this.inner.reprocessDue(command);
      safelyObserve(() => {
        this.telemetry.status('reference', 'PROCESSED', result.processed);
        this.telemetry.status('reference', 'REJECTED', result.rejected);
        this.telemetry.retry('reference', result.rescheduled);
      });
      return result;
    } catch (error) {
      safelyObserve(() => {
        for (const failure of error instanceof AggregateError
          ? (error.errors as unknown[])
          : [error])
          this.telemetry.lockFailure(failure, 'reference');
      });
      throw error;
    }
  }
}
