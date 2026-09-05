import type { OutboxMessage } from '../../domain/entities/outbox-message.js';

export interface LeasedOutboxMessage {
  message: OutboxMessage;
  token: string;
}
export abstract class OutboxRepository {
  public abstract claim(
    token: string,
    leaseMs: number,
  ): Promise<LeasedOutboxMessage | null>;
  public abstract markPublished(claim: LeasedOutboxMessage): Promise<boolean>;
  public abstract scheduleRetry(
    claim: LeasedOutboxMessage,
    delayMs: number,
  ): Promise<boolean>;
}
export abstract class IntegrationEventPublisher {
  public abstract publish(message: OutboxMessage): Promise<void>;
}
export interface OutboxObserver {
  record(
    outcome: 'published' | 'retry' | 'lease_lost',
    message: OutboxMessage,
  ): void;
}
