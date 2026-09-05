import { Migration } from '@mikro-orm/migrations';

export class Migration20260908120000 extends Migration {
  public override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_shape",
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
                  ("status" = 'PROCESSED' and "reference_transaction_id" is not null)
                  or
                  ("status" = 'REJECTED' and (
                    "reference_transaction_id" is not null
                    or ("reference_transaction_id" is null and "failure_code" = 'REFERENCE_NOT_FOUND')
                  ))
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
              ("status" = 'PROCESSED' and "reference_transaction_id" is not null)
              or
              ("status" = 'REJECTED' and (
                "reference_transaction_id" is not null
                or ("reference_transaction_id" is null and "failure_code" = 'REFERENCE_NOT_FOUND')
              ))
            )
          )
        )
    `);
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_attempts" integer not null default 0,
        add column "next_reference_attempt_at" timestamptz(3) null,
        add column "reference_expires_at" timestamptz(3) null,
        add constraint "wager_transactions_reference_attempts_non_negative"
          check ("reference_attempts" >= 0)
    `);
    this.addSql(`
      update "wager_transactions"
      set
        "next_reference_attempt_at" = "created_at",
        "reference_expires_at" = "created_at" + interval '24 hours'
      where "status" = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_retry_shape" check (
          (
            "status" = 'PENDING_REFERENCE'
            and "next_reference_attempt_at" is not null
            and "reference_expires_at" is not null
          )
          or
          (
            "status" <> 'PENDING_REFERENCE'
            and "next_reference_attempt_at" is null
            and "reference_expires_at" is null
          )
        )
    `);
    this.addSql(`
      create index "wager_transactions_pending_reference_due_index"
      on "wager_transactions" ("next_reference_attempt_at", "created_at")
      where "status" = 'PENDING_REFERENCE'
    `);
  }

  public override down(): void {
    this.addSql(
      'drop index if exists "wager_transactions_pending_reference_due_index"',
    );
    this.addSql(`
      update "wager_transactions"
      set
        "status" = 'PENDING_REFERENCE',
        "failure_code" = null,
        "next_reference_attempt_at" = "created_at",
        "reference_expires_at" = "created_at" + interval '24 hours'
      where
        "status" = 'REJECTED'
        and "failure_code" = 'REFERENCE_NOT_FOUND'
        and "reference_transaction_id" is null
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_retry_shape",
        drop constraint if exists "wager_transactions_reference_attempts_non_negative",
        drop column "reference_expires_at",
        drop column "next_reference_attempt_at",
        drop column "reference_attempts"
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_shape",
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
              ("reference_external_transaction_id" is null and "reference_transaction_id" is null)
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
  }
}
