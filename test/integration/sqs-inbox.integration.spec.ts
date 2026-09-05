import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerConsumer } from '../../src/modules/wallet/infrastructure/messaging/sqs-wager-consumer.js';
import { SqsConsumerRunner } from '../../src/modules/wallet/infrastructure/messaging/sqs-consumer.runner.js';
import { WagerTransactionKind } from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { SqsTestContext } from './support/sqs-test-context.js';

const context = new SqsTestContext(
  `sqs_inbox_${randomUUID().replaceAll('-', '')}`,
);
describe('SQS e Inbox com PostgreSQL e LocalStack reais', () => {
  beforeAll(() => context.start());
  afterAll(() => context.stop());

  it('deduplica messageId e comando entre mensagens diferentes, mantendo Inbox e financeiro', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '25.00',
    );
    const messageId = randomUUID();
    const body = context.envelope(input, messageId);
    await context.send(body);
    await context.consumer().pollOnce();
    await context.send(body);
    await context.consumer().pollOnce();
    const anotherId = randomUUID();
    await context.send(context.envelope(input, anotherId));
    await context.consumer().pollOnce();
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(1);
    const inbox = await context.inbox(messageId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.processedAt).toBeTruthy();
    expect((await context.inbox(anotherId))[0]?.transactionId).toBe(
      inbox[0]?.transactionId,
    );
    expect(
      (await context.createUseCase().execute(input)).idempotentReplay,
    ).toBe(true);
    await context.expectReconciled(wallet.id);
  });

  it('reverte Inbox, wallet, transação, ledger e outbox quando a conclusão da Inbox falha', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    const messageId = randomUUID();
    await context.send(context.envelope(input, messageId));
    await context.failInboxCompletion(true);
    const outboxBefore = await context.countWalletOutbox(wallet.id);
    try {
      await context.consumer().pollOnce();
      expect(await context.countWalletOutbox(wallet.id)).toBe(outboxBefore);
      expect(await context.inbox(messageId)).toHaveLength(0);
      expect(
        await context.countTransactions(wallet.id, WagerTransactionKind.Bet),
      ).toBe(0);
      expect(
        await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
      ).toBe(0);
      expect(await context.walletState(wallet.id)).toMatchObject({
        balance: '100.00',
      });
    } finally {
      await context.failInboxCompletion(false);
    }
    expect(await context.consumer().pollOnce()).toBe(1);
    expect(await context.inbox(messageId)).toHaveLength(1);
    expect(await context.walletState(wallet.id)).toMatchObject({
      balance: '90.00',
    });
    await context.expectReconciled(wallet.id);
  });

  it('confirma rejeição de negócio com Inbox e sem lançamento financeiro', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '0.00');
    const messageId = randomUUID();
    await context.send(
      context.envelope(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '10.00',
        ),
        messageId,
      ),
    );
    await context.consumer().pollOnce();
    const inbox = await context.inbox(messageId);
    expect(
      await context.transactionState(inbox[0]!.transactionId),
    ).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(0);
    expect(await context.consumer().pollOnce()).toBe(0);
    await context.expectReconciled(wallet.id);
  });

  it('envia OPENING externo para DLQ antes de remover a mensagem original', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '0.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    const body = JSON.parse(context.envelope(input)) as {
      data: { kind: string };
    };
    body.data.kind = 'OPENING';
    await context.send(JSON.stringify(body));
    await context.consumer().pollOnce();
    expect(
      (await context.deadLetter())?.MessageAttributes?.failureCode?.StringValue,
    ).toBe('INVALID_WAGER_REQUEST');
    expect(await context.consumer().pollOnce()).toBe(0);
    await context.expectReconciled(wallet.id);
  });

  it('rejeita mesmo messageId com payload divergente sem repetir débito', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    const messageId = randomUUID();
    await context.send(context.envelope(input, messageId));
    await context.consumer().pollOnce();
    await context.send(
      context.envelope(
        { ...input, money: { amount: '20.00', currency: 'BRL' } },
        messageId,
      ),
    );
    await context.consumer().pollOnce();
    expect(
      (await context.deadLetter())?.MessageAttributes?.failureCode?.StringValue,
    ).toBe('INBOX_PAYLOAD_CONFLICT');
    expect(await context.walletState(wallet.id)).toMatchObject({
      balance: '90.00',
    });
    expect(await context.inbox(messageId)).toHaveLength(1);
    await context.expectReconciled(wallet.id);
  });

  it('limita falhas transitórias e encaminha a mensagem auditável para DLQ', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const messageId = randomUUID();
    await context.send(
      context.envelope(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '10.00',
        ),
        messageId,
      ),
    );
    await context.failInboxCompletion(true);
    try {
      const consumer = context.consumer({ maximumAttempts: 2 });
      expect(await consumer.pollOnce()).toBe(1);
      expect(await consumer.pollOnce()).toBe(1);
      expect(
        (await context.deadLetter())?.MessageAttributes?.failureCode
          ?.StringValue,
      ).toBe('PROCESSING_ATTEMPTS_EXHAUSTED');
      expect(await context.inbox(messageId)).toHaveLength(0);
      expect(await context.walletState(wallet.id)).toMatchObject({
        balance: '100.00',
      });
    } finally {
      await context.failInboxCompletion(false);
    }
    await context.expectReconciled(wallet.id);
  });

  it('50 mensagens em três processos produzem um débito sem depender do grupo FIFO', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const messageId = randomUUID();
    const body = context.envelope(
      context.wagerInput(WagerTransactionKind.Bet, wallet.id, player, '10.00'),
      messageId,
    );
    await Promise.all(Array.from({ length: 50 }, () => context.send(body)));
    const results = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = context.worker();
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exit !== 0) throw new Error(`Worker SQS falhou: ${stderr}`);
        return JSON.parse(stdout) as { processed: number };
      }),
    );
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(50);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '90.00',
      version: 2,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(1);
    expect(await context.inbox(messageId)).toHaveLength(1);
    await context.expectReconciled(wallet.id);
  }, 30000);

  it('recupera redelivery após matar processo entre commit e ack', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const messageId = randomUUID();
    await context.send(
      context.envelope(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '10.00',
        ),
        messageId,
      ),
    );
    const child = context.worker(true);
    const [exit, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(exit).not.toBe(0);
    expect(output).toContain('COMMITTED_BEFORE_ACK');
    expect(await context.inbox(messageId)).toHaveLength(1);
    expect(await context.consumer({ waitSeconds: 5 }).pollOnce()).toBe(1);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '90.00',
      version: 2,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(1);
    await context.expectReconciled(wallet.id);
  }, 15000);

  it('mantém a origem quando o envio à DLQ falha e recupera na próxima entrega', async () => {
    await context.send('{invalid-json');
    // Injeta a falha apenas no envio à DLQ, mantendo receive/delete reais.
    context.client.middlewareStack.add(
      (next, command) =>
        async (args): ReturnType<typeof next> => {
          if (command.commandName === 'SendMessageCommand')
            throw new Error('DLQ unavailable');
          return next(args);
        },
      { step: 'initialize', name: 'failDlq' },
    );
    try {
      const result = await Promise.allSettled([context.consumer().pollOnce()]);
      expect(result[0]).toMatchObject({
        status: 'rejected',
        reason: new Error('DLQ unavailable'),
      });
    } finally {
      context.client.middlewareStack.remove('failDlq');
    }
    expect(await context.consumer({ waitSeconds: 5 }).pollOnce()).toBe(1);
    expect((await context.deadLetter())?.Body).toBe('{invalid-json');
    expect(await context.consumer().pollOnce()).toBe(0);
  }, 10000);

  it('renova a visibilidade e aguarda o processamento ativo durante shutdown', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const messageId = randomUUID();
    await context.send(
      context.envelope(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '10.00',
        ),
        messageId,
      ),
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const useCase = context.createUseCase();
    const execute = useCase.execute.bind(useCase);
    const delayed = spyOn(useCase, 'execute').mockImplementation(
      async (input, inbox) => {
        started.resolve();
        await release.promise;
        return execute(input, inbox);
      },
    );
    const client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    });
    const runner = new SqsConsumerRunner(
      new SqsWagerConsumer(client, useCase, context.options()),
    );
    const previous = process.env.SQS_CONSUMER_ENABLED;
    process.env.SQS_CONSUMER_ENABLED = 'true';
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      runner.onModuleInit();
      await started.promise;
      stopping = runner.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Bun.sleep(2400);
      expect(stopped).toBe(false);
      expect(await context.consumer().pollOnce()).toBe(0);
      expect(await context.inbox(messageId)).toHaveLength(0);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
      expect(await context.inbox(messageId)).toHaveLength(1);
      expect(await context.consumer().pollOnce()).toBe(0);
      expect(await context.walletState(wallet.id)).toMatchObject({
        balance: '90.00',
      });
      await context.expectReconciled(wallet.id);
    } finally {
      release.resolve();
      await (stopping ?? runner.onModuleDestroy());
      delayed.mockRestore();
      if (previous === undefined) delete process.env.SQS_CONSUMER_ENABLED;
      else process.env.SQS_CONSUMER_ENABLED = previous;
    }
  }, 10000);
});
