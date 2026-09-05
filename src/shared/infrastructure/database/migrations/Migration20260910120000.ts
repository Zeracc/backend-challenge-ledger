import { Migration } from '@mikro-orm/migrations';

export class Migration20260910120000 extends Migration {
  public override up(): void {
    this.addSql(`create table "inbox_messages" (
      consumer_name varchar(100) not null,
      message_id varchar(200) not null,
      payload_hash varchar(64) not null,
      received_at timestamptz(3) not null,
      processed_at timestamptz(3) null,
      transaction_id uuid null references wager_transactions(id) on delete restrict,
      constraint inbox_messages_pkey primary key (consumer_name, message_id),
      constraint inbox_identity_valid check (length(trim(consumer_name)) > 0 and length(trim(message_id)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'),
      constraint inbox_processed_shape check ((processed_at is null and transaction_id is null) or (processed_at is not null and transaction_id is not null))
    )`);
  }
  public override down(): void {
    this.addSql('drop table "inbox_messages"');
  }
}
