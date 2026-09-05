import type { IntegrationEvent } from '../../../../shared/domain/events/integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  public static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }
  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    if (
      !Number.isInteger(state.attempts) ||
      state.attempts < 0 ||
      state.payload.eventId !== state.id ||
      state.payload.aggregateId !== state.aggregateId ||
      state.payload.eventType !== state.eventType
    )
      throw new Error('Estado de Outbox inválido.');
    return new OutboxMessage({
      ...state,
      payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt),
      ...(state.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: new Date(state.nextAttemptAt) }),
      ...(state.publishedAt === undefined
        ? {}
        : { publishedAt: new Date(state.publishedAt) }),
    });
  }
  public get id(): string {
    return this.state.id;
  }
  public get aggregateId(): string {
    return this.state.aggregateId;
  }
  public get eventType(): string {
    return this.state.eventType;
  }
  public get payload(): Readonly<Record<string, unknown>> {
    return structuredClone(this.state.payload);
  }
  public get occurredAt(): Date {
    return new Date(this.state.occurredAt);
  }
  public get attempts(): number {
    return this.state.attempts;
  }
  public get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt === undefined
      ? undefined
      : new Date(this.state.nextAttemptAt);
  }
  public get publishedAt(): Date | undefined {
    return this.state.publishedAt === undefined
      ? undefined
      : new Date(this.state.publishedAt);
  }
  public isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  public isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this.state.nextAttemptAt === undefined ||
        this.state.nextAttemptAt <= now)
    );
  }
  public markPublished(at: Date): void {
    this.requirePending();
    this.state.publishedAt = new Date(at);
    delete this.state.nextAttemptAt;
  }
  public scheduleRetry(now: Date): number {
    this.requirePending();
    this.state.attempts += 1;
    const delayMs = Math.min(
      300_000,
      1000 * 2 ** Math.min(this.state.attempts - 1, 20),
    );
    this.state.nextAttemptAt = new Date(now.getTime() + delayMs);
    return delayMs;
  }
  private requirePending(): void {
    if (!this.isPending()) throw new Error('Evento já publicado.');
  }
}
