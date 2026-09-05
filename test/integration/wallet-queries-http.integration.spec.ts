import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryWalletUseCase } from '../../src/modules/wallet/application/use-cases/query-wallet.js';
import type {
  LedgerPage,
  ReconciliationView,
  TransactionView,
  WalletView,
} from '../../src/modules/wallet/application/ports/wallet-read.repository.js';
import { WagerTransactionKind } from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { MikroOrmWalletReadRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-read.repository.js';
import { ReconciliationTelemetry } from '../../src/modules/wallet/infrastructure/observability/reconciliation.telemetry.js';
import { WalletQueriesController } from '../../src/modules/wallet/presentation/http/wallet-queries.controller.js';
import {
  WagerTestContext,
  captureRejection,
} from './support/wager-test-context.js';

const context = new WagerTestContext(
  `wallet_queries_${randomUUID().replaceAll('-', '')}`,
);
let app: INestApplication;
let baseUrl: string;
const telemetry = new ReconciliationTelemetry();
let repository: MikroOrmWalletReadRepository;

describe('consultas e reconciliação HTTP com PostgreSQL', () => {
  beforeAll(async () => {
    await context.start();
    repository = new MikroOrmWalletReadRepository(context.getOrm().em);
    const module = await Test.createTestingModule({
      controllers: [WalletQueriesController],
      providers: [
        {
          provide: QueryWalletUseCase,
          useValue: new QueryWalletUseCase(repository, telemetry),
        },
        { provide: ReconciliationTelemetry, useValue: telemetry },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await context.stop();
  });

  it('consulta wallet e saldo histórico da transação por ambas as identidades', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const external = randomUUID();
    const bet = await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '20.00',
          { externalTransactionId: external },
        ),
      );
    await context
      .createUseCase()
      .execute(
        context.wagerInput(WagerTransactionKind.Win, wallet.id, player, '5.00'),
      );
    expect(await json<WalletView>(`/wallets/${wallet.id}`)).toEqual({
      id: wallet.id,
      playerId: player,
      balance: { amount: '85.00', currency: 'BRL' },
      version: 3,
    });
    const transaction = await json<TransactionView>(
      `/wagering/transactions/${bet.transactionId}`,
    );
    expect(transaction).toMatchObject({
      transactionId: bet.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      balance: { amount: '80.00', currency: 'BRL' },
    });
    expect(
      await json<TransactionView>(
        `/providers/provider-a/wagering/transactions/${external}`,
      ),
    ).toEqual(transaction);
    expect(transaction).not.toHaveProperty('payloadHash');
    expect(transaction).not.toHaveProperty('idempotencyKey');
    expect(
      (
        await fetch(
          `${baseUrl}/providers/provider-b/wagering/transactions/${external}`,
        )
      ).status,
    ).toBe(404);
    await context.expectReconciled(wallet.id);
  });

  it('pagina um conjunto fixo apesar de novas movimentações com timestamps anteriores', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    let timestamp = new Date('2026-09-09T00:00:00.000Z');
    const useCase = context.createUseCase(context.getOrm(), undefined, {
      now: () => timestamp,
    });
    for (let i = 0; i < 3; i++)
      await useCase.execute(
        context.wagerInput(WagerTransactionKind.Bet, wallet.id, player, '1.00'),
      );
    const first = await json<LedgerPage>(
      `/wallets/${wallet.id}/ledger?limit=2`,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    const secondWallet = await context.openWallet(randomUUID(), '10.00');
    expect(
      (
        await fetch(
          `${baseUrl}/wallets/${secondWallet.id}/ledger?cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    timestamp = new Date('2026-09-01T00:00:00.000Z');
    const later = await useCase.execute(
      context.wagerInput(WagerTransactionKind.Win, wallet.id, player, '3.00'),
    );
    const second = await json<LedgerPage>(
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(4);
    expect(
      second.items.some((x) => x.transactionId === later.transactionId),
    ).toBe(false);
    const fresh = await json<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    expect(fresh.items).toHaveLength(5);
    expect(
      await json<LedgerPage>(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`,
      ),
    ).toEqual(second);
    await context.expectReconciled(wallet.id);
  });

  it('ordena sequências numericamente ao atravessar a quantidade de dígitos', async () => {
    await context
      .connection()
      .execute(
        "select setval(pg_get_serial_sequence(?, 'sequence'), 9998, false)",
        [`${context.schemaName}.wallet_ledger_entries`],
      );
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const useCase = context.createUseCase();
    const bet = await useCase.execute(
      context.wagerInput(WagerTransactionKind.Bet, wallet.id, player, '1.00'),
    );
    const win = await useCase.execute(
      context.wagerInput(WagerTransactionKind.Win, wallet.id, player, '1.00'),
    );
    const first = await json<LedgerPage>(
      `/wallets/${wallet.id}/ledger?limit=1`,
    );
    const second = await json<LedgerPage>(
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${first.nextCursor}`,
    );
    const third = await json<LedgerPage>(
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${second.nextCursor}`,
    );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.balanceBefore.amount).toBe('0.00');
    expect(second.items.map((item) => item.transactionId)).toEqual([
      bet.transactionId,
    ]);
    expect(third.items.map((item) => item.transactionId)).toEqual([
      win.transactionId,
    ]);
    expect(third.nextCursor).toBeNull();
    await context.expectReconciled(wallet.id);
  });

  it('reconcilia wallet vazia e responde diferenças negativas sem corrigir dados', async () => {
    const empty = await context.openWallet(randomUUID(), '0.00');
    expect(await json<LedgerPage>(`/wallets/${empty.id}/ledger`)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await json<ReconciliationView>(
        `/wallets/${empty.id}/reconciliation`,
        'POST',
      ),
    ).toEqual({
      walletId: empty.id,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
    const wallet = await context.openWallet(randomUUID(), '10.00');
    const logger = spyOn(Logger.prototype, 'warn').mockImplementation(
      () => undefined,
    );
    try {
      await context
        .connection()
        .execute(
          `update "${context.schemaName}".wallets set balance = 9.00 where id = ?`,
          [wallet.id],
        );
      const result = await json<ReconciliationView>(
        `/wallets/${wallet.id}/reconciliation`,
        'POST',
      );
      expect(result).toMatchObject({
        difference: { amount: '-1.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(await context.walletState(wallet.id)).toMatchObject({
        balance: '9.00',
      });
      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'wallet_reconciliation_mismatch',
          walletId: wallet.id,
        }),
      );
      expect(JSON.stringify(logger.mock.calls)).toContain('correlationId');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('9.00');
      expect(await (await fetch(`${baseUrl}/metrics`)).text()).toContain(
        'wallet_reconciliation_mismatches_total 1',
      );
    } finally {
      logger.mockRestore();
      await context
        .connection()
        .execute(
          `update "${context.schemaName}".wallets set balance = 10.00 where id = ?`,
          [wallet.id],
        );
    }
    await context.expectReconciled(wallet.id);
  });

  it('mantém reconciliação consistente durante escritas por conexões independentes', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const cases = await context.independentUseCases(3);
    const writes = Array.from({ length: 20 }, (_, i) =>
      context
        .requiredUseCase(cases, i)
        .execute(
          context.wagerInput(
            WagerTransactionKind.Bet,
            wallet.id,
            player,
            '1.00',
          ),
        ),
    );
    const reads = Array.from({ length: 20 }, () =>
      json<ReconciliationView>(`/wallets/${wallet.id}/reconciliation`, 'POST'),
    );
    const [, results] = await Promise.all([
      Promise.all(writes),
      Promise.all(reads),
    ]);
    expect(
      results.every((r) => r.consistent && r.difference.amount === '0.00'),
    ).toBe(true);
    expect(
      await json(`/wallets/${wallet.id}/reconciliation`, 'POST'),
    ).toMatchObject({
      checkedEntries: 21,
      storedBalance: { amount: '80.00' },
      consistent: true,
    });
    await context.expectReconciled(wallet.id);
  });

  it('traduz timeout real do PostgreSQL para 503 e permite recuperação', async () => {
    const wallet = await context.openWallet(randomUUID(), '0.00');
    const query = spyOn(repository, 'wallet').mockImplementation(async () => {
      await context
        .getOrm()
        .em.fork()
        .transactional(async (em) => {
          await em.execute("set local statement_timeout = '1ms'");
          await em.execute('select pg_sleep(0.1)');
        });
      return null;
    });
    try {
      const response = await fetch(`${baseUrl}/wallets/${wallet.id}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'INFRASTRUCTURE_UNAVAILABLE',
      });
    } finally {
      query.mockRestore();
    }
    expect((await fetch(`${baseUrl}/wallets/${wallet.id}`)).status).toBe(200);
  });

  it('consulta pendências, rejeições e reconcilia operações mistas sem ledger de LOSS', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const useCase = context.createUseCase();
    const external = randomUUID();
    await useCase.execute(
      context.wagerInput(WagerTransactionKind.Bet, wallet.id, player, '20.00', {
        externalTransactionId: external,
      }),
    );
    await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        player,
        '20.00',
        { referenceExternalTransactionId: external },
      ),
    );
    await useCase.execute(
      context.wagerInput(WagerTransactionKind.Loss, wallet.id, player, '1.00'),
    );
    const rejected = await useCase.execute(
      context.wagerInput(WagerTransactionKind.Bet, wallet.id, player, '200.00'),
    );
    const pending = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        player,
        '1.00',
        { referenceExternalTransactionId: randomUUID() },
      ),
    );
    expect(
      await json<TransactionView>(
        `/wagering/transactions/${pending.transactionId}`,
      ),
    ).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(
      await json<TransactionView>(
        `/wagering/transactions/${rejected.transactionId}`,
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(
      await json<ReconciliationView>(
        `/wallets/${wallet.id}/reconciliation`,
        'POST',
      ),
    ).toMatchObject({
      consistent: true,
      checkedEntries: 3,
      calculatedBalance: { amount: '100.00' },
    });
    const ledger = await json<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    expect(ledger.items).toHaveLength(3);
    const opening = ledger.items[0];
    expect(
      await json<TransactionView>(
        `/wagering/transactions/${opening?.transactionId}`,
      ),
    ).toMatchObject({ kind: 'OPENING' });
    await context.expectReconciled(wallet.id);
  });

  it('preserva valores e imutabilidade ao migrar ledger já preenchido', async () => {
    const wallet = await context.openWallet(
      randomUUID(),
      '999999999999999999.99',
    );
    const before = await json<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    await context.getOrm().migrator.down({
      schema: context.schemaName,
      to: 'Migration20260908120000',
    });
    await context.getOrm().migrator.up({ schema: context.schemaName });
    expect(await json<LedgerPage>(`/wallets/${wallet.id}/ledger`)).toEqual(
      before,
    );
    expect(
      await json<ReconciliationView>(
        `/wallets/${wallet.id}/reconciliation`,
        'POST',
      ),
    ).toMatchObject({
      consistent: true,
      calculatedBalance: { amount: '999999999999999999.99' },
    });
    const mutation = context
      .connection()
      .execute(
        `update "${context.schemaName}".wallet_ledger_entries set amount = 1.00 where wallet_id = ?`,
        [wallet.id],
      );
    const error = await captureRejection(mutation);
    expect(error instanceof Error ? error.message : '').toContain('immutable');
    await context.expectReconciled(wallet.id);
  });

  it('distingue recursos ausentes, UUIDs inválidos, limites e cursores inválidos', async () => {
    const absent = randomUUID();
    for (const path of [
      `/wallets/${absent}`,
      `/wallets/${absent}/ledger`,
      `/wagering/transactions/${absent}`,
    ])
      expect((await fetch(baseUrl + path)).status).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/wallets/${absent}/reconciliation`, {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    const wallet = await context.openWallet(randomUUID(), '0.00');
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=-1',
      'limit=1.5',
      'limit=1&limit=2',
      'cursor=',
      'cursor=bad',
      'cursor=eyJ2ZXJzaW9uIjoyfQ',
    ]) {
      expect(
        (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?${query}`)).status,
      ).toBe(400);
    }
    expect((await fetch(`${baseUrl}/wallets/not-a-uuid`)).status).toBe(400);
  });
});

async function json<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
): Promise<T> {
  const response = await fetch(baseUrl + path, { method });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}
