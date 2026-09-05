import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsEventPublisher } from '../../src/modules/wallet/infrastructure/messaging/sqs-event.publisher.js';
import { PublishOutboxUseCase } from '../../src/modules/wallet/application/use-cases/publish-outbox.js';
import { OutboxScheduler } from '../../src/modules/wallet/infrastructure/scheduling/outbox.scheduler.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { OutboxTestContext } from './support/outbox-test-context.js';
import { WagerTransactionKind } from '../../src/modules/wallet/domain/entities/wager-transaction.js';

let context: OutboxTestContext;
describe('Outbox com PostgreSQL e SQS reais', () => {
  beforeEach(async () => {
    context = new OutboxTestContext(
      `outbox_${randomUUID().replaceAll('-', '')}`,
    );
    await context.start();
  });
  afterEach(async () => {
    await context.stop();
  });

  it('não publica antes do commit financeiro e publica o envelope persistido depois', async () => {
    const em = context.getOrm().em.fork();
    await em.begin();
    const wallet = await context.openWallet(randomUUID(), '100.00', 'BRL', em);
    try {
      expect((await context.publisher().execute()).claimed).toBe(0);
      expect(await context.events()).toHaveLength(0);
      await em.commit();
    } catch (error) {
      if (em.isInTransaction()) await em.rollback();
      throw error;
    }
    const stored = await context.outbox();
    expect((await context.publisher().execute()).published).toBe(2);
    const events = await context.events();
    expect(events.sort(byEventId)).toEqual(
      stored.map((row) => row.payload).sort(byEventId),
    );
    expect(
      (await context.outbox()).every(
        (row) => row.publishedAt !== null && row.leaseOwner === null,
      ),
    ).toBe(true);
    expect((await context.publisher().execute()).claimed).toBe(0);
    await context.expectReconciled(wallet.id);
  });

  it('três publishers disputam 60 eventos sem perder ou republicar eventos concluídos', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 30 }, () =>
        context.openWallet(randomUUID(), '100.00'),
      ),
    );
    const workers = Array.from({ length: 3 }, () => context.publisherWorker());
    const results = await Promise.all(
      workers.map(async (worker) => {
        const [exit, output, error] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ]);
        if (exit !== 0) throw new Error(error);
        return JSON.parse(output) as { published: number };
      }),
    );
    expect(results.reduce((sum, row) => sum + row.published, 0)).toBe(60);
    const events = await context.events();
    expect(events).toHaveLength(60);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(60);
    expect(
      (await context.outbox()).filter((row) => row.publishedAt === null),
    ).toHaveLength(0);
    for (const wallet of wallets) await context.expectReconciled(wallet.id);
  }, 30000);

  it.each(['after_claim', 'after_send'] as const)(
    'recupera outro processo morto em %s com eventId estável',
    async (crash) => {
      const wallet = await context.openWallet(randomUUID(), '100.00');
      const stored = await context.outbox();
      const worker = context.publisherWorker(crash);
      const [exit, output] = await Promise.all([
        worker.exited,
        new Response(worker.stdout).text(),
      ]);
      expect(exit).not.toBe(0);
      expect(output).toContain(crash === 'after_claim' ? 'CLAIMED:' : 'SENT:');
      expect(
        (await context.outbox()).every((row) => row.publishedAt === null),
      ).toBe(true);
      await Bun.sleep(1100);
      expect((await context.publisher().execute()).published).toBe(2);
      const events = await context.events();
      expect(new Set(events.map((event) => event.eventId))).toEqual(
        new Set(stored.map((row) => row.id)),
      );
      expect(
        (await context.outbox()).every((row) => row.publishedAt !== null),
      ).toBe(true);
      await context.expectReconciled(wallet.id);
    },
    10000,
  );

  it('reagenda falha de SQS no banco e continua publicando os demais eventos', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    let fail = true;
    context.client.middlewareStack.add(
      (next, command) =>
        async (args): ReturnType<typeof next> => {
          if (fail && command.commandName === 'SendMessageCommand') {
            fail = false;
            throw new Error('SQS unavailable');
          }
          return next(args);
        },
      { step: 'initialize', name: 'failFirstSend' },
    );
    const result = await context.publisher().execute();
    expect(result).toMatchObject({ published: 1, retried: 1 });
    const failed = (await context.outbox()).find(
      (row) => row.publishedAt === null,
    );
    expect(failed).toMatchObject({ attempts: 1, leaseOwner: null });
    expect(failed?.nextAttemptAt).toBeTruthy();
    expect((await context.publisher().execute()).claimed).toBe(0);
    await Bun.sleep(1100);
    expect((await context.publisher().execute()).published).toBe(1);
    expect(await context.events()).toHaveLength(2);
    await context.expectReconciled(wallet.id);
  });

  it('impede confirmação e retry por dono antigo após expiração e nova reserva', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    const repository = context.repository();
    const old = (await repository.claim(randomUUID(), 1))!;
    await Bun.sleep(5);
    expect(await repository.markPublished(old)).toBe(false);
    const current = (await repository.claim(randomUUID(), 30000))!;
    expect(current.message.id).toBe(old.message.id);
    old.message.scheduleRetry(new Date());
    expect(await repository.scheduleRetry(old, 1000)).toBe(false);
    expect(await repository.markPublished(old)).toBe(false);
    expect(await repository.markPublished(current)).toBe(true);
    expect(await repository.markPublished(current)).toBe(false);
    await context.expectReconciled(wallet.id);
  });

  it('protege envelope, lease e estado terminal no schema real', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    const row = (await context.outbox())[0]!;
    const table = `"${context.schemaName}".outbox_messages`;
    for (const sql of [
      `update ${table} set payload = '{}' where id = ?`,
      `update ${table} set lease_owner = 'alone' where id = ?`,
    ]) {
      const [result] = await Promise.allSettled([
        context.connection().execute(sql, [row.id]),
      ]);
      expect(result?.status).toBe('rejected');
    }
    await context.publisher().execute();
    const [reset] = await Promise.allSettled([
      context
        .connection()
        .execute(`update ${table} set published_at = null where id = ?`, [
          row.id,
        ]),
    ]);
    expect(reset?.status).toBe('rejected');
    await context.expectReconciled(wallet.id);
  });

  it('aguarda envio ativo no shutdown e deixa o restante do lote disponível', async () => {
    const wallet = await context.openWallet(randomUUID(), '100.00');
    const client = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
    const transport = new SqsEventPublisher(client, context.queueUrl);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publish = transport.publish.bind(transport);
    const delayed = spyOn(transport, 'publish').mockImplementation(
      async (message) => {
        started.resolve();
        await release.promise;
        await publish(message);
      },
    );
    const scheduler = new OutboxScheduler(
      new PublishOutboxUseCase(
        context.repository(),
        transport,
        new UuidGenerator(),
        new SystemClock(),
      ),
      transport,
    );
    const previous = process.env.OUTBOX_PUBLISHER_ENABLED;
    process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
    let stopped = false;
    let closing: Promise<void> | undefined;
    try {
      scheduler.onModuleInit();
      await started.promise;
      closing = scheduler.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await closing;
      expect(stopped).toBe(true);
      expect(delayed).toHaveBeenCalledTimes(1);
      expect(
        (await context.outbox()).filter((row) => row.publishedAt === null),
      ).toHaveLength(1);
      expect((await context.publisher().execute()).published).toBe(1);
      expect(await context.events()).toHaveLength(2);
      await context.expectReconciled(wallet.id);
    } finally {
      release.resolve();
      await (closing ?? scheduler.onModuleDestroy());
      delayed.mockRestore();
      if (previous === undefined) delete process.env.OUTBOX_PUBLISHER_ENABLED;
      else process.env.OUTBOX_PUBLISHER_ENABLED = previous;
    }
  });

  it('publica os quatro tipos de evento, inclusive LOSS e referência pendente', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '10.00');
    await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Loss,
          wallet.id,
          player,
          '10.00',
        ),
      );
    await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '20.00',
        ),
      );
    await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Refund,
          wallet.id,
          player,
          '10.00',
          { referenceExternalTransactionId: randomUUID() },
        ),
      );
    await context.publisher().execute();
    const events = await context.events();
    expect(new Set(events.map((event) => event.eventType))).toEqual(
      new Set([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WagerTransactionRejected',
        'WagerTransactionPendingReference',
      ]),
    );
    expect(
      events.filter((event) => event.eventType === 'WalletBalanceChanged'),
    ).toHaveLength(1);
    await context.expectReconciled(wallet.id);
  });
});

function byEventId(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  return String(a.eventId).localeCompare(String(b.eventId));
}
