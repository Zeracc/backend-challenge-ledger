import { Migration } from '@mikro-orm/migrations';

export class Migration20260912120000 extends Migration {
  public override up(): void {
    // FKs propagam a política da wallet às transações e ao ledger.
    this.addSql(
      "alter table wallets add constraint wallets_supported_currency check (currency in ('BRL', 'USD', 'EUR'))",
    );
    this
      .addSql(`create function protect_terminal_wager() returns trigger language plpgsql as $$ begin
      if old.status in ('PROCESSED', 'REJECTED', 'FAILED') and new is distinct from old then
        raise exception 'Terminal wager transaction is immutable' using errcode = '23514';
      end if;
      return new;
    end; $$`);
    this.addSql(
      'create trigger wager_terminal_immutable after update on wager_transactions for each row execute function protect_terminal_wager()',
    );
  }
  public override down(): void {
    this.addSql('drop trigger wager_terminal_immutable on wager_transactions');
    this.addSql('drop function protect_terminal_wager()');
    this.addSql(
      'alter table wallets drop constraint wallets_supported_currency',
    );
  }
}
