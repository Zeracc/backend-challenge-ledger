import { describe, expect, it } from 'bun:test';

import { PendingReferenceRetryPolicy } from './pending-reference-retry-policy.js';

describe('PendingReferenceRetryPolicy', () => {
  const policy = new PendingReferenceRetryPolicy({
    maximumAttempts: 8,
    ttlMs: 60_000,
    baseDelayMs: 1_000,
    maximumDelayMs: 5_000,
    batchSize: 20,
  });
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('define expiração e backoff exponencial com teto', () => {
    expect(policy.expiresAt(now)).toEqual(new Date('2026-09-08T12:01:00.000Z'));
    expect(policy.nextAttemptAt(now, 1)).toEqual(
      new Date('2026-09-08T12:00:01.000Z'),
    );
    expect(policy.nextAttemptAt(now, 3)).toEqual(
      new Date('2026-09-08T12:00:04.000Z'),
    );
    expect(policy.nextAttemptAt(now, 8)).toEqual(
      new Date('2026-09-08T12:00:05.000Z'),
    );
  });

  it('expõe os limites usados pelo worker', () => {
    expect(policy.maximumAttempts).toBe(8);
    expect(policy.batchSize).toBe(20);
    expect(policy.baseDelayMs).toBe(1_000);
    expect(policy.maximumDelayMs).toBe(5_000);
  });
});
