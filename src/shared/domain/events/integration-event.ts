export interface IntegrationEventProps<TData extends object> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<TData>;
}

export interface IntegrationEventEnvelope<TData extends object> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: Readonly<TData>;
}

export abstract class IntegrationEvent<TData extends object> {
  public abstract readonly eventType: string;
  public abstract readonly version: number;

  public readonly eventId: string;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly causationId: string | undefined;
  public readonly data: Readonly<TData>;
  private readonly occurrenceDate: Date;

  protected constructor(props: IntegrationEventProps<TData>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurrenceDate = new Date(props.occurredAt.getTime());
    this.data = Object.freeze({ ...props.data });
  }

  public get occurredAt(): Date {
    return new Date(this.occurrenceDate.getTime());
  }

  public toJSON(): IntegrationEventEnvelope<TData> {
    const envelope: IntegrationEventEnvelope<TData> = {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };

    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }

    return envelope;
  }
}
