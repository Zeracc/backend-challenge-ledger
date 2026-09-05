import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxTestContext } from './support/outbox-test-context.js';
import { OperationalTelemetry } from '../../src/modules/wallet/infrastructure/observability/operational.telemetry.js';
import { OperationalMetricsService } from '../../src/modules/wallet/infrastructure/observability/operational-metrics.service.js';
import { ReconciliationTelemetry } from '../../src/modules/wallet/infrastructure/observability/reconciliation.telemetry.js';
import { WalletQueriesController } from '../../src/modules/wallet/presentation/http/wallet-queries.controller.js';
import { WageringController } from '../../src/modules/wallet/presentation/http/wagering.controller.js';
import { QueryWalletUseCase } from '../../src/modules/wallet/application/use-cases/query-wallet.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { MikroOrmWalletReadRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-read.repository.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { PublishOutboxUseCase } from '../../src/modules/wallet/application/use-cases/publish-outbox.js';
import { SqsEventPublisher } from '../../src/modules/wallet/infrastructure/messaging/sqs-event.publisher.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';

let context: OutboxTestContext;
let telemetry: OperationalTelemetry;
let useCase: ProcessWagerTransactionUseCase;
let metrics: OperationalMetricsService;
let app: INestApplication;
let base: string;

describe('Observabilidade com PostgreSQL, HTTP e SQS reais', () => {
  beforeEach(async () => {
    context = new OutboxTestContext(
      `metrics_${randomUUID().replaceAll('-', '')}`,
    );
    await context.start();
    telemetry = new OperationalTelemetry();
    useCase = context.createUseCase(undefined, undefined, undefined, telemetry);
    metrics = new OperationalMetricsService(context.getOrm().em, telemetry);
    const reconciliation = new ReconciliationTelemetry();
    const module = await Test.createTestingModule({
      controllers: [WalletQueriesController, WageringController],
      providers: [
        { provide: ProcessWagerTransactionUseCase, useValue: useCase },
        { provide: OperationalMetricsService, useValue: metrics },
        { provide: ReconciliationTelemetry, useValue: reconciliation },
        {
          provide: QueryWalletUseCase,
          useValue: new QueryWalletUseCase(
            new MikroOrmWalletReadRepository(context.getOrm().em),
            reconciliation,
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterEach(async () => {
    await app?.close();
    await context.stop();
  });

  it('exporta resultados únicos, replay e histogramas sem dados financeiros nos logs', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '12.34',
    );
    const log = spyOn(Logger.prototype, 'log').mockImplementation(
      () => undefined,
    );
    try {
      expect((await post(input)).status).toBe(200);
      expect((await post(input)).status).toBe(200);
      await post(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '200.00',
        ),
      );
      const response = await fetch(`${base}/metrics`);
      const body = await response.text();
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(body).toContain(
        'wager_transactions_total{source="http",status="PROCESSED"} 1',
      );
      expect(body).toContain(
        'wager_transactions_total{source="http",status="REJECTED"} 1',
      );
      expect(body).toContain('wager_duplicates_total{source="http"} 1');
      expect(body).toContain(
        'wager_processing_duration_seconds_count{source="http"} 3',
      );
      expect(body).toContain(
        'wager_processing_duration_seconds_bucket{source="http",le="+Inf"} 3',
      );
      expect(body).not.toContain(wallet.id);
      const logs = JSON.stringify(log.mock.calls);
      expect(logs).toContain(wallet.id);
      expect(logs).toContain('correlationId');
      expect(logs).not.toContain('12.34');
      expect(logs).not.toContain('87.66');
      expect(await context.walletState(wallet.id)).toMatchObject({
        balance: '87.66',
      });
      await context.expectReconciled(wallet.id);
    } finally {
      log.mockRestore();
    }
  });

  it('falha da telemetria após commit não altera resposta nem repete débito', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    const broken = spyOn(telemetry, 'completed').mockImplementation(() => {
      throw new Error('metrics unavailable');
    });
    try {
      const first = await useCase.execute(input);
      const replay = await useCase.execute(input);
      expect(first.status).toBe(WagerTransactionStatus.Processed);
      expect(replay.idempotentReplay).toBe(true);
      expect(
        await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
      ).toBe(1);
      await context.expectReconciled(wallet.id);
    } finally {
      broken.mockRestore();
    }
  });

  it('não vaza parâmetros financeiros quando o banco retorna erro inesperado', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    await context
      .connection()
      .execute(
        `create function "${context.schemaName}".unexpected_failure() returns trigger language plpgsql as $$ begin raise exception 'secret-financial-payload-12.34' using errcode = 'P0001'; end; $$`,
      );
    await context
      .connection()
      .execute(
        `create trigger unexpected_failure before insert on "${context.schemaName}".wager_transactions for each row execute function "${context.schemaName}".unexpected_failure()`,
      );
    const log = spyOn(Logger.prototype, 'error').mockImplementation(
      () => undefined,
    );
    try {
      const response = await post(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '12.34',
        ),
      );
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).toContain('INTERNAL_ERROR');
      expect(body).not.toContain('12.34');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-financial');
      expect(JSON.stringify(log.mock.calls)).toContain(
        'financial_http_unexpected_error',
      );
      expect(
        await context.countTransactions(wallet.id, WagerTransactionKind.Bet),
      ).toBe(0);
      await context.expectReconciled(wallet.id);
    } finally {
      log.mockRestore();
    }
  });

  it('registra conflito de lock real e mantém rollback financeiro', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const blocker = context.getOrm().em.fork();
    await blocker.begin();
    try {
      await blocker.execute(
        `select id from "${context.schemaName}".wallets where id = ? for update`,
        [wallet.id],
      );
      // O timeout é configurado na sessão financeira por um trigger real.
      await context
        .connection()
        .execute(
          `create function "${context.schemaName}".short_lock() returns trigger language plpgsql as $$ begin perform set_config('lock_timeout', '100ms', true); return new; end; $$`,
        );
      await context
        .connection()
        .execute(
          `create trigger short_lock before insert on "${context.schemaName}".inbox_messages for each row execute function "${context.schemaName}".short_lock()`,
        );
      const result = await Promise.allSettled([
        useCase.execute(
          context.wagerInput(
            WagerTransactionKind.Bet,
            wallet.id,
            player,
            '10.00',
          ),
          {
            consumerName: 'metrics',
            messageId: randomUUID(),
            payloadHash: 'a'.repeat(64),
          },
        ),
      ]);
      expect(result[0]?.status).toBe('rejected');
      expect(telemetry.render()).toContain(
        'wager_lock_conflicts_total{source="sqs",code="55P03"} 1',
      );
      expect(
        await context.countTransactions(wallet.id, WagerTransactionKind.Bet),
      ).toBe(0);
    } finally {
      await blocker.rollback();
    }
    await context.expectReconciled(wallet.id);
  });

  it('contabiliza retry e DLQ somente após as operações de transporte', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const consumer = context.consumer({}, useCase, telemetry);
    await context.send(
      context.envelope(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '10.00',
        ),
      ),
    );
    await context.failInboxCompletion(true);
    try {
      await consumer.pollOnce();
    } finally {
      await context.failInboxCompletion(false);
    }
    expect(telemetry.render()).toContain(
      'wager_retries_total{component="sqs"} 1',
    );
    await consumer.pollOnce();
    await context.send('invalid json');
    await consumer.pollOnce();
    expect((await context.deadLetter())?.Body).toBe('invalid json');
    expect(telemetry.render()).toContain('wager_dlq_messages_total 1');
    expect(telemetry.render()).toContain(
      'wager_transactions_total{source="sqs",status="PROCESSED"} 1',
    );
    await context.expectReconciled(wallet.id);
  });

  it('mede pendências e lag global da Outbox e zera após publicação', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    const before = await metrics.render();
    expect(before).toContain('outbox_pending_messages 2');
    expect(
      Number(before.match(/outbox_lag_seconds ([\d.]+)/)?.[1]),
    ).toBeGreaterThanOrEqual(0);
    const publisher = new PublishOutboxUseCase(
      context.repository(),
      new SqsEventPublisher(context.client, context.queueUrl),
      new UuidGenerator(),
      new SystemClock(),
      telemetry,
    );
    await publisher.execute();
    const after = await metrics.render();
    expect(after).toContain('outbox_pending_messages 0');
    expect(after).toContain('outbox_lag_seconds 0');
    expect(after).toContain('outbox_publications_total{outcome="published"} 2');
    expect(await context.events()).toHaveLength(2);
    await context.expectReconciled(wallet.id);
  });

  it('degrada coleta indisponível sem inventar lag zero nem perder contadores', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    const em = context.getOrm().em.fork({ schema: 'missing_metrics_schema' });
    const degraded = await new OperationalMetricsService(
      em,
      telemetry,
    ).render();
    expect(degraded).toContain('operational_metrics_collection_success 0');
    expect(degraded).not.toContain('outbox_lag_seconds');
    expect(degraded).toContain('wager_retries_total');
    await context.expectReconciled(wallet.id);
  });
});

async function post(input: ProcessWagerTransactionInput): Promise<Response> {
  return fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(input),
  });
}
