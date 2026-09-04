import { Migration } from '@mikro-orm/migrations';

export class Migration20260904150000 extends Migration {
  public override up(): void {
    this.addSql(`
      create table "wallets" (
        "id" uuid primary key,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20, 2) not null,
        "version" integer not null,
        "created_at" timestamptz(3) not null,
        "updated_at" timestamptz(3) not null,
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_id_currency_unique" unique ("id", "currency"),
        constraint "wallets_identity_unique" unique ("id", "player_id", "currency"),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1)
      )
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid primary key,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "kind" varchar(16) not null,
        "status" varchar(24) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "created_at" timestamptz(3) not null,
        "processed_at" timestamptz(3) not null,
        constraint "wager_transactions_wallet_identity_fk" foreign key ("wallet_id", "player_id", "currency") references "wallets" ("id", "player_id", "currency") on delete restrict,
        constraint "wager_transactions_identity_unique" unique ("id", "wallet_id", "currency"),
        constraint "wager_transactions_kind" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_opening_processed" check ("kind" <> 'OPENING' or "status" = 'PROCESSED')
      )
    `);
    this.addSql(
      `create unique index "wager_transactions_one_opening_per_wallet" on "wager_transactions" ("wallet_id") where "kind" = 'OPENING'`,
    );

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid primary key,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20, 2) not null,
        "balance_after" numeric(20, 2) not null,
        "created_at" timestamptz(3) not null,
        constraint "wallet_ledger_wallet_currency_fk" foreign key ("wallet_id", "currency") references "wallets" ("id", "currency") on delete restrict,
        constraint "wallet_ledger_transaction_identity_fk" foreign key ("transaction_id", "wallet_id", "currency") references "wager_transactions" ("id", "wallet_id", "currency") on delete restrict,
        constraint "wallet_ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_direction" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_balances_non_negative" check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_balanced" check (
          ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")
          or
          ("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after")
        )
      )
    `);

    this.addSql(`
      create function "prevent_wallet_ledger_mutation"()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet ledger entries are immutable' using errcode = '55000';
      end;
      $$
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "prevent_wallet_ledger_mutation"()
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid primary key,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "event_version" integer not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz(3) not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz(3) null,
        "published_at" timestamptz(3) null,
        "lease_owner" varchar(100) null,
        "lease_expires_at" timestamptz(3) null,
        constraint "outbox_event_version_positive" check ("event_version" >= 1),
        constraint "outbox_attempts_non_negative" check ("attempts" >= 0)
      )
    `);
    this.addSql(
      `create index "outbox_pending_due_index" on "outbox_messages" ("next_attempt_at", "occurred_at") where "published_at" is null`,
    );
  }

  public override down(): void {
    this.addSql('drop table if exists "outbox_messages" cascade');
    this.addSql(
      'drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries"',
    );
    this.addSql('drop function if exists "prevent_wallet_ledger_mutation"()');
    this.addSql('drop table if exists "wallet_ledger_entries" cascade');
    this.addSql('drop table if exists "wager_transactions" cascade');
    this.addSql('drop table if exists "wallets" cascade');
  }
}
