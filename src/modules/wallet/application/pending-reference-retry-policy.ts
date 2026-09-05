export interface PendingReferenceRetryPolicyOptions {
  readonly maximumAttempts: number;
  readonly ttlMs: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
  readonly batchSize: number;
}

const DEFAULT_OPTIONS: PendingReferenceRetryPolicyOptions = {
  maximumAttempts: 8,
  ttlMs: 24 * 60 * 60 * 1000,
  baseDelayMs: 5_000,
  maximumDelayMs: 5 * 60 * 1000,
  batchSize: 100,
};

export class PendingReferenceRetryPolicy {
  public constructor(
    private readonly options: PendingReferenceRetryPolicyOptions = DEFAULT_OPTIONS,
  ) {}

  public get maximumAttempts(): number {
    return this.options.maximumAttempts;
  }

  public get batchSize(): number {
    return this.options.batchSize;
  }

  public get baseDelayMs(): number {
    return this.options.baseDelayMs;
  }

  public get maximumDelayMs(): number {
    return this.options.maximumDelayMs;
  }

  public expiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.options.ttlMs);
  }

  public nextAttemptAt(now: Date, attemptNumber: number): Date {
    const multiplier = 2 ** Math.max(0, attemptNumber - 1);
    const delayMs = Math.min(
      this.options.baseDelayMs * multiplier,
      this.options.maximumDelayMs,
    );

    return new Date(now.getTime() + delayMs);
  }
}
