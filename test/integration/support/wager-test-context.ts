import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { expect } from 'bun:test';
import type { MikroORM, PostgreSqlConnection } from '@mikro-orm/postgresql';

import {
  ProcessWagerTransactionUseCase,
  type ProcessableWagerTransactionKind,
  type ProcessWagerTransactionInput,
} from '../../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { OpenWalletUseCase } from '../../../src/modules/wallet/application/use-cases/open-wallet.js';
import type { WagerTransactionKind } from '../../../src/modules/wallet/domain/entities/wager-transaction.js';
import { MikroOrmWagerTransactionProcessor } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { MikroOrmWalletOpeningRepository } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import type { IdGenerator } from '../../../src/shared/application/ports/id-generator.js';
import { Sha256PayloadHasher } from '../../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../../src/shared/infrastructure/system/uuid-generator.js';
import { createWalletTestOrm } from './wallet-test-orm.js';

export interface WalletRow {
  balance: string;
  version: number;
}

export interface TransactionRow {
  kind: string;
  status: string;
  resultBalance: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface LedgerRow {
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}

export interface WorkerResult {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface WagerInputOptions {
  externalTransactionId?: string;
  idempotencyKey?: string;
  providerId?: string;
  roundId?: string;
  gameId?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

export class WagerTestContext {
  private readonly secondaryOrms: MikroORM[] = [];
  private orm: MikroORM | undefined;

  public constructor(public readonly schemaName: string) {}

  public async start(): Promise<void> {
    this.orm = await createWalletTestOrm(this.schemaName, true);
  }

  public async stop(): Promise<void> {
    await Promise.all(
      this.secondaryOrms.map(async (instance) => instance.close(true)),
    );

    if (this.orm === undefined) {
      return;
    }

    await this.orm.migrator.down({ schema: this.schemaName, to: 0 });
    await this.orm.em
      .getConnection()
      .execute(`drop schema if exists "${this.schemaName}" cascade`);
    await this.orm.close(true);
  }

  public async openWallet(
    playerId: string,
    amount: string,
    currency = 'BRL',
  ): Promise<{ id: string }> {
    return new OpenWalletUseCase(
      new MikroOrmWalletOpeningRepository(this.getOrm().em.fork()),
      new UuidGenerator(),
      new SystemClock(),
    ).execute({
      playerId,
      initialBalance: { amount, currency },
    });
  }

  public createUseCase(
    instance: MikroORM = this.getOrm(),
    idGenerator: IdGenerator = new UuidGenerator(),
  ): ProcessWagerTransactionUseCase {
    return new ProcessWagerTransactionUseCase(
      new MikroOrmWagerTransactionProcessor(instance.em.fork()),
      idGenerator,
      new SystemClock(),
      new Sha256PayloadHasher(),
    );
  }

  public async independentUseCases(
    count = 3,
  ): Promise<ProcessWagerTransactionUseCase[]> {
    const instances = await Promise.all(
      Array.from({ length: count }, () =>
        createWalletTestOrm(this.schemaName, false),
      ),
    );
    this.secondaryOrms.push(...instances);

    return instances.map((instance) => this.createUseCase(instance));
  }

  public requiredUseCase(
    useCases: ProcessWagerTransactionUseCase[],
    index: number,
  ): ProcessWagerTransactionUseCase {
    const useCase = useCases[index % useCases.length];

    if (useCase === undefined) {
      throw new Error('Caso de uso concorrente não encontrado.');
    }

    return useCase;
  }

  public wagerInput(
    kind: ProcessableWagerTransactionKind,
    walletId: string,
    playerId: string,
    amount: string,
    options: WagerInputOptions = {},
  ): ProcessWagerTransactionInput {
    const externalTransactionId = options.externalTransactionId ?? randomUUID();
    const providerId = options.providerId ?? 'provider-a';

    return {
      idempotencyKey:
        options.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId: options.roundId ?? 'round-1',
      gameId: options.gameId ?? 'game-1',
      kind,
      ...(options.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              options.referenceExternalTransactionId,
          }),
      money: { amount, currency: options.currency ?? 'BRL' },
    };
  }

  public async walletState(walletId: string): Promise<WalletRow | undefined> {
    const rows = await this.connection().execute<WalletRow[]>(
      `select "balance", "version" from "${this.schemaName}"."wallets" where "id" = ?`,
      [walletId],
    );

    return rows[0];
  }

  public async transactionState(
    transactionId: string,
  ): Promise<TransactionRow | undefined> {
    const rows = await this.connection().execute<TransactionRow[]>(
      `select "kind", "status", "result_balance" as "resultBalance", "failure_code" as "failureCode", "reference_external_transaction_id" as "referenceExternalTransactionId", "reference_transaction_id" as "referenceTransactionId" from "${this.schemaName}"."wager_transactions" where "id" = ?`,
      [transactionId],
    );

    return rows[0];
  }

  public async ledgerState(
    transactionId: string,
  ): Promise<LedgerRow | undefined> {
    const rows = await this.connection().execute<LedgerRow[]>(
      `select "direction", "amount", "balance_before" as "balanceBefore", "balance_after" as "balanceAfter" from "${this.schemaName}"."wallet_ledger_entries" where "transaction_id" = ?`,
      [transactionId],
    );

    return rows[0];
  }

  public async transactionOutboxTypes(
    transactionId: string,
  ): Promise<string[]> {
    const rows = await this.connection().execute<Array<{ eventType: string }>>(
      `select "event_type" as "eventType" from "${this.schemaName}"."outbox_messages" where "payload"->>'correlationId' = ? order by "event_type"`,
      [transactionId],
    );

    return rows.map((row) => row.eventType);
  }

  public async countTransactionOutbox(transactionId: string): Promise<number> {
    const rows = await this.connection().execute<Array<{ count: number }>>(
      `select count(*)::int as "count" from "${this.schemaName}"."outbox_messages" where "payload"->>'correlationId' = ?`,
      [transactionId],
    );

    return rows[0]?.count ?? 0;
  }

  public async findOpeningOutboxId(walletId: string): Promise<string> {
    const rows = await this.connection().execute<Array<{ id: string }>>(
      `select "id" from "${this.schemaName}"."outbox_messages" where "payload"->'data'->>'walletId' = ? limit 1`,
      [walletId],
    );
    const id = rows[0]?.id;

    if (id === undefined) {
      throw new Error('Evento de abertura não encontrado.');
    }

    return id;
  }

  public async countTransactions(
    walletId: string,
    kind: WagerTransactionKind,
  ): Promise<number> {
    const rows = await this.connection().execute<Array<{ count: number }>>(
      `select count(*)::int as "count" from "${this.schemaName}"."wager_transactions" where "wallet_id" = ? and "kind" = ?`,
      [walletId, kind],
    );

    return rows[0]?.count ?? 0;
  }

  public async countLedgerEntries(
    walletId: string,
    kind: WagerTransactionKind,
  ): Promise<number> {
    const rows = await this.connection().execute<Array<{ count: number }>>(
      `select count(*)::int as "count" from "${this.schemaName}"."wallet_ledger_entries" l join "${this.schemaName}"."wager_transactions" t on t.id = l.transaction_id where l.wallet_id = ? and t.kind = ?`,
      [walletId, kind],
    );

    return rows[0]?.count ?? 0;
  }

  public async expectReconciled(walletId: string): Promise<void> {
    const rows = await this.connection().execute<
      Array<{ ledgerBalance: string; walletBalance: string }>
    >(
      `
        select
          w.balance as "walletBalance",
          coalesce(sum(case l.direction when 'CREDIT' then l.amount when 'DEBIT' then -l.amount end), 0)::numeric(20, 2) as "ledgerBalance"
        from "${this.schemaName}"."wallets" w
        left join "${this.schemaName}"."wallet_ledger_entries" l on l.wallet_id = w.id
        where w.id = ?
        group by w.id
      `,
      [walletId],
    );

    expect(rows[0]?.walletBalance).toBe(rows[0]?.ledgerBalance);
  }

  public async runWagerWorker(
    input: ProcessWagerTransactionInput,
    attempts: number,
  ): Promise<WorkerResult[]> {
    const workerPath = fileURLToPath(
      new URL('../fixtures/wager-process-worker.ts', import.meta.url),
    );
    const child = Bun.spawn([process.execPath, workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WAGER_WORKER_SCHEMA: this.schemaName,
        WAGER_WORKER_INPUT: JSON.stringify(input),
        WAGER_WORKER_ATTEMPTS: attempts.toString(),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(`Worker terminou com código ${exitCode}: ${stderr}`);
    }

    return JSON.parse(stdout) as WorkerResult[];
  }

  public connection(): PostgreSqlConnection {
    return this.getOrm().em.getConnection();
  }

  public getOrm(): MikroORM {
    if (this.orm === undefined) {
      throw new Error('O ORM de teste não foi inicializado.');
    }

    return this.orm;
  }
}

export async function captureRejection(
  operation: Promise<unknown>,
): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }

  throw new Error('A operação de teste deveria ter falhado.');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SequenceIdGenerator implements IdGenerator {
  public constructor(private readonly ids: string[]) {}

  public generate(): string {
    const id = this.ids.shift();

    if (id === undefined) {
      throw new Error('A sequência de IDs do teste foi esgotada.');
    }

    return id;
  }
}
