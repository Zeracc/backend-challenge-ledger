import type { EntityManager } from '@mikro-orm/postgresql';
import {
  OutboxRepository,
  type LeasedOutboxMessage,
} from '../../../application/ports/outbox.repository.js';
import { OutboxMessage } from '../../../domain/entities/outbox-message.js';

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
}
export class MikroOrmOutboxRepository extends OutboxRepository {
  private readonly table: string;
  public constructor(private readonly em: EntityManager) {
    super();
    const schema = em.schema ?? em.config.get('schema') ?? 'public';
    this.table = `"${schema.replaceAll('"', '""')}"."outbox_messages"`;
  }
  public override async claim(
    token: string,
    leaseMs: number,
  ): Promise<LeasedOutboxMessage | null> {
    const rows = await this.em.getConnection().execute<ClaimedRow[]>(
      `
      with candidate as (
        select id from ${this.table}
        where published_at is null
          and (next_attempt_at is null or next_attempt_at <= clock_timestamp())
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
        order by occurred_at, id for update skip locked limit 1
      )
      update ${this.table} o set lease_owner = ?, lease_expires_at = clock_timestamp() + ? * interval '1 millisecond'
      from candidate c where o.id = c.id returning o.*`,
      [token, leaseMs],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      token,
      message: OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
        ...(row.next_attempt_at === null
          ? {}
          : { nextAttemptAt: row.next_attempt_at }),
      }),
    };
  }
  public override async markPublished(
    claim: LeasedOutboxMessage,
  ): Promise<boolean> {
    const rows = await this.em.getConnection().execute<Array<{ id: string }>>(
      `update ${this.table}
      set published_at = clock_timestamp(), next_attempt_at = null, lease_owner = null, lease_expires_at = null
      where id = ? and lease_owner = ? and lease_expires_at > clock_timestamp() and published_at is null returning id`,
      [claim.message.id, claim.token],
    );
    return rows.length === 1;
  }
  public override async scheduleRetry(
    claim: LeasedOutboxMessage,
    delayMs: number,
  ): Promise<boolean> {
    const rows = await this.em.getConnection().execute<Array<{ id: string }>>(
      `update ${this.table}
      set attempts = ?, next_attempt_at = clock_timestamp() + ? * interval '1 millisecond', lease_owner = null, lease_expires_at = null
      where id = ? and lease_owner = ? and lease_expires_at > clock_timestamp() and published_at is null returning id`,
      [claim.message.attempts, delayMs, claim.message.id, claim.token],
    );
    return rows.length === 1;
  }
}
