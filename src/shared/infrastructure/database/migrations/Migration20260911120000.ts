import { Migration } from '@mikro-orm/migrations';

export class Migration20260911120000 extends Migration {
  public override up(): void {
    this
      .addSql(`alter table outbox_messages add constraint outbox_lease_shape check (
      (lease_owner is null and lease_expires_at is null) or
      (lease_owner is not null and length(trim(lease_owner)) > 0 and lease_expires_at is not null)
    )`);
    this
      .addSql(`alter table outbox_messages add constraint outbox_published_shape check (
      published_at is null or (lease_owner is null and lease_expires_at is null and next_attempt_at is null)
    )`);
    this
      .addSql(`create index outbox_claim_index on outbox_messages (occurred_at, id)
      where published_at is null`);
    this
      .addSql(`create function protect_outbox_event() returns trigger language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.event_version, new.payload, new.occurred_at)
          is distinct from (old.id, old.aggregate_id, old.event_type, old.event_version, old.payload, old.occurred_at) then
          raise exception 'Outbox event envelope is immutable' using errcode = '23514';
        end if;
        if old.published_at is not null and new is distinct from old then
          raise exception 'Published outbox event is terminal' using errcode = '23514';
        end if;
        return new;
      end; $$`);
    this
      .addSql(`create trigger outbox_event_immutable before update on outbox_messages
      for each row execute function protect_outbox_event()`);
  }
  public override down(): void {
    this.addSql('drop trigger outbox_event_immutable on outbox_messages');
    this.addSql('drop function protect_outbox_event()');
    this.addSql('drop index outbox_claim_index');
    this.addSql(
      'alter table outbox_messages drop constraint outbox_published_shape',
    );
    this.addSql(
      'alter table outbox_messages drop constraint outbox_lease_shape',
    );
  }
}
