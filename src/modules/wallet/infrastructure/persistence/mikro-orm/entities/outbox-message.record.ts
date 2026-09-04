import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

import type { IntegrationEvent } from '../../../../../../shared/domain/events/integration-event.js';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageRecord {
  @PrimaryKey({ type: 'uuid' })
  public id: string;

  @Property({ type: 'uuid' })
  public aggregateId: string;

  @Property({ length: 100 })
  public eventType: string;

  @Property({ type: 'integer' })
  public eventVersion: number;

  @Property({ type: 'json' })
  public payload: Record<string, unknown>;

  @Property({ columnType: 'timestamptz(3)' })
  public occurredAt: Date;

  @Property({ type: 'integer' })
  public attempts = 0;

  @Property({ columnType: 'timestamptz(3)', nullable: true })
  public nextAttemptAt?: Date;

  @Property({ columnType: 'timestamptz(3)', nullable: true })
  public publishedAt?: Date;

  @Property({ length: 100, nullable: true })
  public leaseOwner?: string;

  @Property({ columnType: 'timestamptz(3)', nullable: true })
  public leaseExpiresAt?: Date;

  public constructor(event: IntegrationEvent<object>) {
    this.id = event.eventId;
    this.aggregateId = event.aggregateId;
    this.eventType = event.eventType;
    this.eventVersion = event.version;
    this.payload = event.toJSON() as unknown as Record<string, unknown>;
    this.occurredAt = event.occurredAt;
  }
}
