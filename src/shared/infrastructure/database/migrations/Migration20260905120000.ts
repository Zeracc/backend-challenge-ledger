import { Migration } from '@mikro-orm/migrations';

export class Migration20260905120000 extends Migration {
  public override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        add column "provider_id" varchar(100) null,
        add column "external_transaction_id" varchar(150) null,
        add column "idempotency_key" varchar(200) null,
        add column "payload_hash" char(64) null,
        add column "round_id" varchar(150) null,
        add column "game_id" varchar(150) null,
        add column "reference_external_transaction_id" varchar(150) null,
        add column "reference_transaction_id" uuid null,
        add column "failure_code" varchar(50) null,
        add column "result_balance" numeric(20, 2) null,
        add column "result_currency" varchar(3) null
    `);
    this.addSql(`
      update "wager_transactions"
      set "result_balance" = "amount", "result_currency" = "currency"
      where "kind" = 'OPENING'
    `);
    this.addSql(`
      alter table "wager_transactions"
        alter column "processed_at" drop not null,
        alter column "result_balance" set not null,
        alter column "result_currency" set not null,
        add constraint "wager_transactions_reference_fk"
          foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict,
        add constraint "wager_transactions_external_shape" check (
          (
            "kind" = 'OPENING'
            and "provider_id" is null
            and "external_transaction_id" is null
            and "idempotency_key" is null
            and "payload_hash" is null
            and "round_id" is null
            and "game_id" is null
          )
          or
          (
            "kind" <> 'OPENING'
            and "provider_id" is not null
            and "external_transaction_id" is not null
            and "idempotency_key" is not null
            and "payload_hash" is not null
            and "round_id" is not null
            and "game_id" is not null
          )
        ),
        add constraint "wager_transactions_payload_hash_format" check (
          "payload_hash" is null or "payload_hash" ~ '^[a-f0-9]{64}$'
        ),
        add constraint "wager_transactions_result_balance_non_negative" check ("result_balance" >= 0),
        add constraint "wager_transactions_result_currency" check ("result_currency" = "currency"),
        add constraint "wager_transactions_terminal_shape" check (
          ("status" = 'PROCESSED' and "processed_at" is not null and "failure_code" is null)
          or
          ("status" = 'REJECTED' and "processed_at" is null and "failure_code" is not null)
          or
          ("status" in ('PENDING', 'PENDING_REFERENCE') and "processed_at" is null and "failure_code" is null)
          or
          ("status" = 'FAILED' and "processed_at" is null and "failure_code" is not null)
        )
    `);
    this.addSql(`
      create unique index "wager_transactions_idempotency_key_unique"
      on "wager_transactions" ("idempotency_key")
      where "idempotency_key" is not null
    `);
    this.addSql(`
      create unique index "wager_transactions_provider_external_unique"
      on "wager_transactions" ("provider_id", "external_transaction_id")
      where "provider_id" is not null and "external_transaction_id" is not null
    `);
  }

  public override down(): void {
    this.addSql(
      'drop index if exists "wager_transactions_provider_external_unique"',
    );
    this.addSql(
      'drop index if exists "wager_transactions_idempotency_key_unique"',
    );
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_terminal_shape",
        drop constraint if exists "wager_transactions_result_currency",
        drop constraint if exists "wager_transactions_result_balance_non_negative",
        drop constraint if exists "wager_transactions_payload_hash_format",
        drop constraint if exists "wager_transactions_external_shape",
        drop constraint if exists "wager_transactions_reference_fk"
    `);
    this.addSql(`
      update "wager_transactions"
      set "processed_at" = "created_at"
      where "processed_at" is null
    `);
    this.addSql(`
      alter table "wager_transactions"
        alter column "processed_at" set not null,
        drop column "result_currency",
        drop column "result_balance",
        drop column "failure_code",
        drop column "reference_transaction_id",
        drop column "reference_external_transaction_id",
        drop column "game_id",
        drop column "round_id",
        drop column "payload_hash",
        drop column "idempotency_key",
        drop column "external_transaction_id",
        drop column "provider_id"
    `);
  }
}
