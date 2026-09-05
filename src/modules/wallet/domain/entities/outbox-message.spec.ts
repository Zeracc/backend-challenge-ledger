import { describe, expect, it } from 'bun:test';
import { OutboxMessage, type OutboxMessageState } from './outbox-message.js';

describe('OutboxMessage', () => {
  const state: OutboxMessageState = {
    id: 'event',
    aggregateId: 'wallet',
    eventType: 'WalletBalanceChanged',
    payload: {
      eventId: 'event',
      aggregateId: 'wallet',
      eventType: 'WalletBalanceChanged',
      data: { amount: '1.00' },
    },
    occurredAt: new Date('2026-09-05T00:00:00Z'),
    attempts: 0,
  };
  it('calcula backoff persistível com teto sem descartar o evento', () => {
    const message = OutboxMessage.rehydrate(state);
    const now = new Date('2026-09-05T00:00:00Z');
    expect(message.isDue(now)).toBe(true);
    expect(message.scheduleRetry(now)).toBe(1000);
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 1000))).toBe(true);
    expect(message.scheduleRetry(now)).toBe(2000);
    for (let attempt = 0; attempt < 20; attempt++) message.scheduleRetry(now);
    expect(message.scheduleRetry(now)).toBe(300000);
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(23);
  });
  it('preserva payload e datas e torna publicação terminal', () => {
    const message = OutboxMessage.rehydrate(state);
    const data = message.payload.data as Record<string, unknown>;
    data.amount = '999.00';
    message.occurredAt.setUTCFullYear(2000);
    expect(message.payload).toEqual(state.payload);
    expect(message.occurredAt.getUTCFullYear()).toBe(2026);
    const now = new Date('2026-09-05T00:00:00Z');
    message.scheduleRetry(now);
    message.markPublished(now);
    now.setUTCFullYear(2000);
    expect(message.publishedAt?.getUTCFullYear()).toBe(2026);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isDue(now)).toBe(false);
    expect(() => message.scheduleRetry(now)).toThrow();
    expect(() => message.markPublished(now)).toThrow();
  });
});
