import { Injectable, Logger } from '@nestjs/common';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../application/ports/wager-transaction.processor.js';
import type { OutboxObserver } from '../../application/ports/outbox.repository.js';
import type { OutboxMessage } from '../../domain/entities/outbox-message.js';

type Source = 'http' | 'sqs' | 'reference';
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class OperationalTelemetry implements OutboxObserver {
  private readonly counters = new Map<string, number>();
  private readonly latency = new Map<
    Source,
    { count: number; sum: number; buckets: number[] }
  >();
  private readonly logger = new Logger('WagerOperations');

  public constructor() {
    for (const source of ['http', 'sqs', 'reference'] as const) {
      for (const status of [
        'PROCESSED',
        'REJECTED',
        'PENDING_REFERENCE',
        'FAILED',
      ])
        this.status(source, status, 0);
      this.increment(`wager_duplicates_total{source="${source}"}`, 0);
      this.increment(`wager_processing_failures_total{source="${source}"}`, 0);
      for (const code of ['55P03', '40P01', '40001'])
        this.increment(
          `wager_lock_conflicts_total{source="${source}",code="${code}"}`,
          0,
        );
      if (source !== 'reference')
        this.latency.set(source, {
          count: 0,
          sum: 0,
          buckets: BUCKETS.map(() => 0),
        });
    }
    for (const component of ['sqs', 'outbox', 'reference'] as const)
      this.retry(component, 0);
    this.increment('wager_dlq_messages_total', 0);
    for (const outcome of ['published', 'retry', 'lease_lost'])
      this.increment(`outbox_publications_total{outcome="${outcome}"}`, 0);
  }

  public completed(
    command: ProcessWagerTransactionCommand,
    result: ProcessWagerTransactionResult,
    seconds: number,
  ): void {
    const source = command.inbox === undefined ? 'http' : 'sqs';
    if (result.idempotentReplay)
      this.increment(`wager_duplicates_total{source="${source}"}`);
    else this.status(source, result.status);
    this.duration(source, seconds);
    this.logger.log({
      event: 'wager_completed',
      correlationId: result.transactionId,
      messageId: command.inbox?.messageId,
      transactionId: result.transactionId,
      walletId: command.transaction.walletId,
      providerId: command.transaction.providerId,
      source,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });
  }
  public failed(
    command: ProcessWagerTransactionCommand,
    error: unknown,
    seconds: number,
  ): void {
    const source = command.inbox === undefined ? 'http' : 'sqs';
    this.increment(`wager_processing_failures_total{source="${source}"}`);
    this.duration(source, seconds);
    this.lockFailure(error, source);
    this.logger.warn({
      event: 'wager_processing_failed',
      correlationId: command.transaction.id,
      messageId: command.inbox?.messageId,
      transactionId: command.transaction.id,
      walletId: command.transaction.walletId,
      providerId: command.transaction.providerId,
      source,
    });
  }
  public status(source: Source, status: string, count = 1): void {
    if (
      !['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'].includes(status)
    )
      return;
    this.increment(
      `wager_transactions_total{source="${source}",status="${status}"}`,
      count,
    );
  }
  public retry(component: 'sqs' | 'outbox' | 'reference', count = 1): void {
    this.increment(`wager_retries_total{component="${component}"}`, count);
  }
  public deadLetter(): void {
    this.increment('wager_dlq_messages_total');
  }
  public lockFailure(error: unknown, source: Source): void {
    const code = sqlCode(error);
    if (code !== undefined && ['55P03', '40P01', '40001'].includes(code))
      this.increment(
        `wager_lock_conflicts_total{source="${source}",code="${code}"}`,
      );
  }
  public record(
    outcome: 'published' | 'retry' | 'lease_lost',
    message: OutboxMessage,
  ): void {
    if (outcome === 'retry') this.retry('outbox');
    this.increment(`outbox_publications_total{outcome="${outcome}"}`);
    const payload = message.payload;
    const data = payload.data as Record<string, unknown> | undefined;
    this.logger.log({
      event: `outbox_${outcome}`,
      eventId: message.id,
      messageId: message.id,
      correlationId: payload.correlationId,
      transactionId: data?.transactionId,
      walletId: data?.walletId,
      providerId: data?.providerId,
      eventType: message.eventType,
      attempts: message.attempts,
    });
  }
  public render(): string {
    let result = '';
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_processing_failures_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'outbox_publications_total',
    ]) {
      result += `# HELP ${name} Observed operations in this process since startup.\n# TYPE ${name} counter\n`;
      for (const [key, value] of this.counters)
        if (key === name || key.startsWith(`${name}{`))
          result += `${key} ${value}\n`;
    }
    result +=
      '# HELP wager_processing_duration_seconds Financial processing time including database waits and replays.\n# TYPE wager_processing_duration_seconds histogram\n';
    for (const [source, state] of this.latency) {
      BUCKETS.forEach((bucket, index) => {
        result += `wager_processing_duration_seconds_bucket{source="${source}",le="${bucket}"} ${state.buckets[index]}\n`;
      });
      result += `wager_processing_duration_seconds_bucket{source="${source}",le="+Inf"} ${state.count}\n`;
      result += `wager_processing_duration_seconds_count{source="${source}"} ${state.count}\nwager_processing_duration_seconds_sum{source="${source}"} ${state.sum}\n`;
    }
    return result;
  }
  private increment(key: string, count = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + count);
  }
  private duration(source: Source, seconds: number): void {
    const state = this.latency.get(source) ?? {
      count: 0,
      sum: 0,
      buckets: BUCKETS.map(() => 0),
    };
    state.count++;
    state.sum += seconds;
    BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket)
        state.buckets[index] = (state.buckets[index] ?? 0) + 1;
    });
    this.latency.set(source, state);
  }
}

export function safelyObserve(action: () => void): void {
  try {
    action();
  } catch {
    /* Telemetria não participa da decisão financeira. */
  }
}
function sqlCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== 'object' || error === null)
    return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return sqlCode(candidate.cause, depth + 1);
}
