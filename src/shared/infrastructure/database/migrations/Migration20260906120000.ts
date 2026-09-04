import { Migration } from '@mikro-orm/migrations';

export class Migration20260906120000 extends Migration {
  public override up(): void {
    this.addSql(`
      create function "validate_wallet_ledger_transaction_effect"()
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
    this.addSql(`
      create trigger "wallet_ledger_transaction_effect"
      before insert on "wallet_ledger_entries"
      for each row execute function "validate_wallet_ledger_transaction_effect"()
    `);
  }

  public override down(): void {
    this.addSql(
      'drop trigger if exists "wallet_ledger_transaction_effect" on "wallet_ledger_entries"',
    );
    this.addSql(
      'drop function if exists "validate_wallet_ledger_transaction_effect"()',
    );
  }
}
