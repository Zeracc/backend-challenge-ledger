import { Migration } from '@mikro-orm/migrations';

export class Migration20260907120000 extends Migration {
  public override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_shape" check (
          (
            "kind" in ('OPENING', 'BET', 'LOSS')
            and "reference_external_transaction_id" is null
            and "reference_transaction_id" is null
          )
          or
          (
            "kind" = 'WIN'
            and (
              (
                "reference_external_transaction_id" is null
                and "reference_transaction_id" is null
              )
              or
              (
                "reference_external_transaction_id" is not null
                and (
                  ("status" = 'PENDING_REFERENCE' and "reference_transaction_id" is null)
                  or
                  ("status" in ('PROCESSED', 'REJECTED') and "reference_transaction_id" is not null)
                )
              )
            )
          )
          or
          (
            "kind" in ('REFUND', 'ROLLBACK')
            and "reference_external_transaction_id" is not null
            and (
              ("status" = 'PENDING_REFERENCE' and "reference_transaction_id" is null)
              or
              ("status" in ('PROCESSED', 'REJECTED') and "reference_transaction_id" is not null)
            )
          )
        )
    `);
    this.addSql(`
      create unique index "wager_transactions_processed_reversal_unique"
      on "wager_transactions" ("reference_transaction_id", "kind")
      where "status" = 'PROCESSED' and "kind" in ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      create or replace function "validate_wallet_ledger_transaction_effect"()
      returns trigger
      language plpgsql
      as $$
      declare
        transaction_kind varchar(16);
        transaction_status varchar(24);
        transaction_amount numeric(20, 2);
        transaction_reference_id uuid;
        reference_kind varchar(16);
      begin
        execute format(
          'select "kind", "status", "amount", "reference_transaction_id" from %I."wager_transactions" where "id" = $1',
          tg_table_schema
        )
        into transaction_kind, transaction_status, transaction_amount, transaction_reference_id
        using new."transaction_id";

        if transaction_kind is null then
          raise exception 'wallet ledger transaction does not exist' using errcode = '23503';
        end if;

        if transaction_status <> 'PROCESSED' then
          raise exception 'wallet ledger requires a processed transaction' using errcode = '23514';
        end if;

        if transaction_amount <> new."amount" then
          raise exception 'wallet ledger amount differs from transaction amount' using errcode = '23514';
        end if;

        if transaction_kind = 'LOSS' then
          raise exception 'LOSS cannot create a wallet ledger entry' using errcode = '23514';
        end if;

        if transaction_kind in ('OPENING', 'WIN', 'REFUND') and new."direction" <> 'CREDIT' then
          raise exception 'transaction requires a CREDIT wallet ledger entry' using errcode = '23514';
        end if;

        if transaction_kind = 'BET' and new."direction" <> 'DEBIT' then
          raise exception 'BET requires a DEBIT wallet ledger entry' using errcode = '23514';
        end if;

        if transaction_kind = 'ROLLBACK' then
          execute format(
            'select "kind" from %I."wager_transactions" where "id" = $1',
            tg_table_schema
          )
          into reference_kind
          using transaction_reference_id;

          if reference_kind = 'BET' and new."direction" <> 'CREDIT' then
            raise exception 'ROLLBACK of BET requires a CREDIT wallet ledger entry' using errcode = '23514';
          end if;

          if reference_kind in ('WIN', 'REFUND') and new."direction" <> 'DEBIT' then
            raise exception 'ROLLBACK of credit requires a DEBIT wallet ledger entry' using errcode = '23514';
          end if;
        end if;

        return new;
      end;
      $$
    `);
  }

  public override down(): void {
    this.addSql(
      'drop index if exists "wager_transactions_processed_reversal_unique"',
    );
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_shape"
    `);
    this.addSql(`
      create or replace function "validate_wallet_ledger_transaction_effect"()
      returns trigger
      language plpgsql
      as $$
      declare
        transaction_kind varchar(16);
        transaction_status varchar(24);
        transaction_amount numeric(20, 2);
      begin
        execute format(
          'select "kind", "status", "amount" from %I."wager_transactions" where "id" = $1',
          tg_table_schema
        )
        into transaction_kind, transaction_status, transaction_amount
        using new."transaction_id";

        if transaction_kind is null then
          raise exception 'wallet ledger transaction does not exist' using errcode = '23503';
        end if;

        if transaction_status <> 'PROCESSED' then
          raise exception 'wallet ledger requires a processed transaction' using errcode = '23514';
        end if;

        if transaction_amount <> new."amount" then
          raise exception 'wallet ledger amount differs from transaction amount' using errcode = '23514';
        end if;

        if transaction_kind = 'LOSS' then
          raise exception 'LOSS cannot create a wallet ledger entry' using errcode = '23514';
        end if;

        if transaction_kind in ('OPENING', 'WIN') and new."direction" <> 'CREDIT' then
          raise exception 'transaction requires a CREDIT wallet ledger entry' using errcode = '23514';
        end if;

        if transaction_kind = 'BET' and new."direction" <> 'DEBIT' then
          raise exception 'BET requires a DEBIT wallet ledger entry' using errcode = '23514';
        end if;

        return new;
      end;
      $$
    `);
  }
}
