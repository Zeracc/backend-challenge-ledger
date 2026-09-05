import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  InvalidLedgerCursorError,
  WalletReadRepository,
  type LedgerPage,
  type ReconciliationView,
  type TransactionView,
  type WalletView,
} from '../../../application/ports/wallet-read.repository.js';
import { WalletRecord } from './entities/wallet.record.js';
import { WagerTransactionRecord } from './entities/wager-transaction.record.js';

interface Cursor {
  version: 1;
  walletId: string;
  after: string;
  ceiling: string;
}
interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: string | Date;
  sequence: string;
}

export class MikroOrmWalletReadRepository extends WalletReadRepository {
  public constructor(private readonly entityManager: EntityManager) {
    super();
  }

  public async wallet(walletId: string): Promise<WalletView | null> {
    const record = await this.entityManager
      .fork()
      .findOne(WalletRecord, { id: walletId });
    return record === null
      ? null
      : {
          id: record.id,
          playerId: record.playerId,
          balance: { amount: record.balance, currency: record.currency },
          version: record.version,
        };
  }

  public async transaction(
    identity:
      { id: string } | { providerId: string; externalTransactionId: string },
  ): Promise<TransactionView | null> {
    const record = await this.entityManager
      .fork()
      .findOne(WagerTransactionRecord, identity);
    if (record === null) return null;
    return {
      transactionId: record.id,
      walletId: record.walletId,
      playerId: record.playerId,
      ...(record.providerId === undefined
        ? {}
        : { providerId: record.providerId }),
      ...(record.externalTransactionId === undefined
        ? {}
        : { externalTransactionId: record.externalTransactionId }),
      ...(record.roundId === undefined ? {} : { roundId: record.roundId }),
      ...(record.gameId === undefined ? {} : { gameId: record.gameId }),
      kind: record.kind,
      status: record.status,
      money: { amount: record.amount, currency: record.currency },
      balance: {
        amount: record.resultBalance,
        currency: record.resultCurrency,
      },
      ...(record.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              record.referenceExternalTransactionId,
          }),
      ...(record.referenceTransactionId === undefined
        ? {}
        : { referenceTransactionId: record.referenceTransactionId }),
      ...(record.failureCode === undefined
        ? {}
        : { failureCode: record.failureCode }),
      createdAt: record.createdAt.toISOString(),
      ...(record.processedAt === undefined
        ? {}
        : { processedAt: record.processedAt.toISOString() }),
    };
  }

  public async ledger(
    walletId: string,
    limit: number,
    token?: string,
  ): Promise<LedgerPage | null> {
    const cursor =
      token === undefined ? undefined : decodeCursor(token, walletId);
    return this.entityManager.fork().transactional(
      async (em) => {
        if ((await em.findOne(WalletRecord, { id: walletId })) === null)
          return null;
        const table = this.table(em, 'wallet_ledger_entries');
        const maximum =
          cursor === undefined
            ? await em.execute<Array<{ ceiling: string }>>(
                `select coalesce(max(sequence), 0)::text as ceiling from ${table} where wallet_id = ?`,
                [walletId],
              )
            : undefined;
        const ceiling = cursor?.ceiling ?? maximum?.[0]?.ceiling ?? '0';
        const rows = await em.execute<LedgerRow[]>(
          `
        select id, wallet_id as "walletId", transaction_id as "transactionId", direction,
          amount::text, currency, balance_before::text as "balanceBefore",
          balance_after::text as "balanceAfter", created_at as "createdAt", sequence::text
        from ${table}
        where wallet_id = ? and sequence > ?::bigint and sequence <= ?::bigint
        order by sequence asc limit ?`,
          [walletId, cursor?.after ?? '0', ceiling, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map((row) => ({
            id: row.id,
            walletId: row.walletId,
            transactionId: row.transactionId,
            direction: row.direction,
            money: { amount: row.amount, currency: row.currency },
            balanceBefore: {
              amount: row.balanceBefore,
              currency: row.currency,
            },
            balanceAfter: { amount: row.balanceAfter, currency: row.currency },
            createdAt: new Date(row.createdAt).toISOString(),
          })),
          nextCursor:
            rows.length > limit && last !== undefined
              ? Buffer.from(
                  JSON.stringify({
                    version: 1,
                    walletId,
                    after: last.sequence,
                    ceiling,
                  } satisfies Cursor),
                ).toString('base64url')
              : null,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }

  public async reconcile(walletId: string): Promise<ReconciliationView | null> {
    const em = this.entityManager.fork();
    const rows = await em.execute<
      Array<{
        walletId: string;
        currency: string;
        stored: string;
        calculated: string;
        difference: string;
        consistent: boolean;
        count: number;
      }>
    >(
      `
      select w.id as "walletId", w.currency, w.balance::text as stored,
        coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00)::text as calculated,
        (w.balance - coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00))::text as difference,
        w.balance = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00) as consistent,
        count(l.id)::int as count
      from ${this.table(em, 'wallets')} w
      left join ${this.table(em, 'wallet_ledger_entries')} l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
      [walletId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          walletId: row.walletId,
          storedBalance: { amount: row.stored, currency: row.currency },
          calculatedBalance: { amount: row.calculated, currency: row.currency },
          difference: { amount: row.difference, currency: row.currency },
          consistent: row.consistent,
          checkedEntries: row.count,
        };
  }

  private table(em: EntityManager, name: string): string {
    const schema = em.schema ?? em.config.get('schema') ?? 'public';
    return `"${schema.replaceAll('"', '""')}"."${name}"`;
  }
}

function decodeCursor(token: string, walletId: string): Cursor {
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new InvalidLedgerCursorError();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token)
      throw new InvalidLedgerCursorError();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null)
      throw new InvalidLedgerCursorError();
    const c = value as Record<string, unknown>;
    if (
      c.version !== 1 ||
      c.walletId !== walletId ||
      !isSequence(c.after) ||
      !isSequence(c.ceiling) ||
      BigInt(c.after) > BigInt(c.ceiling)
    )
      throw new InvalidLedgerCursorError();
    return { version: 1, walletId, after: c.after, ceiling: c.ceiling };
  } catch {
    throw new InvalidLedgerCursorError();
  }
}

function isSequence(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
