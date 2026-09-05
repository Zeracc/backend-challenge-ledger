import { describe, expect, it } from 'bun:test';
import { InboxMessage, InboxPayloadConflictError } from './inbox-message.js';

describe('InboxMessage', () => {
  const identity = {
    consumerName: 'consumer',
    messageId: 'message',
    payloadHash: 'a'.repeat(64),
  };
  it('preserva identidade e datas contra mutação externa', () => {
    const receivedAt = new Date('2026-09-05T00:00:00Z');
    const message = InboxMessage.receive({ ...identity, receivedAt });
    receivedAt.setUTCFullYear(2000);
    message.receivedAt.setUTCFullYear(2001);
    expect(message.receivedAt.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    const processedAt = new Date('2026-09-05T00:00:01Z');
    message.markProcessed('transaction', processedAt);
    processedAt.setUTCFullYear(2000);
    message.processedAt?.setUTCFullYear(2001);
    expect(message.processedAt?.toISOString()).toBe('2026-09-05T00:00:01.000Z');
    expect(() => message.markProcessed('other', new Date())).toThrow();
    expect(message.transactionId).toBe('transaction');
  });
  it('aceita replay equivalente e recusa payload divergente', () => {
    const message = InboxMessage.receive({
      ...identity,
      receivedAt: new Date(),
    });
    expect(() => message.assertPayload(identity.payloadHash)).not.toThrow();
    expect(() => message.assertPayload('b'.repeat(64))).toThrow(
      InboxPayloadConflictError,
    );
  });
  it('recusa identidades vazias ou hashes inválidos', () => {
    for (const override of [
      { consumerName: ' ' },
      { messageId: '' },
      { payloadHash: 'abc' },
    ]) {
      expect(() =>
        InboxMessage.receive({
          ...identity,
          ...override,
          receivedAt: new Date(),
        }),
      ).toThrow();
    }
  });
});
