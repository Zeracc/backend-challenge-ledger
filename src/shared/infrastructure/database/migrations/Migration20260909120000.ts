import { Migration } from '@mikro-orm/migrations';

export class Migration20260909120000 extends Migration {
  public override up(): void {
    // Identidade de paginação; não reescreve valores nem timestamps financeiros.
    this.addSql(
      'alter table "wallet_ledger_entries" add column "sequence" bigint generated always as identity',
    );
    this.addSql(
      'create unique index "wallet_ledger_wallet_sequence_unique" on "wallet_ledger_entries" ("wallet_id", "sequence")',
    );
  }
  public override down(): void {
    this.addSql('drop index "wallet_ledger_wallet_sequence_unique"');
    this.addSql('alter table "wallet_ledger_entries" drop column "sequence"');
  }
}
