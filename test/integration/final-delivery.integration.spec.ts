import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { OutboxTestContext } from './support/outbox-test-context.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { WageringController } from '../../src/modules/wallet/presentation/http/wagering.controller.js';

let context: OutboxTestContext;
let app: INestApplication | undefined;
describe('fechamento dos critérios com serviços reais', () => {
  beforeEach(async () => {
    context = new OutboxTestContext(
      `final_${randomUUID().replaceAll('-', '')}`,
    );
    await context.start();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await context.stop();
  });

  it('persiste FAILED e Inbox após esgotar retries, publica diagnóstico e impede replay financeiro', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    await context
      .connection()
      .execute(
        `create function "${context.schemaName}".fail_wallet_write() returns trigger language plpgsql as $$ begin raise exception 'wallet write unavailable' using errcode = '40001'; end; $$`,
      );
    await context
      .connection()
      .execute(
        `create trigger fail_wallet_write before update on "${context.schemaName}".wallets for each row execute function "${context.schemaName}".fail_wallet_write()`,
      );
    const messageId = randomUUID();
    await context.send(context.envelope(input, messageId));
    const consumer = context.consumer({ maximumAttempts: 2 });
    await consumer.pollOnce();
    await consumer.pollOnce();
    expect(
      (await context.deadLetter())?.MessageAttributes?.failureCode?.StringValue,
    ).toBe('PROCESSING_ATTEMPTS_EXHAUSTED');
    const inbox = await context.inbox(messageId);
    expect(inbox).toHaveLength(1);
    const id = inbox[0]!.transactionId;
    expect(await context.transactionState(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_ATTEMPTS_EXHAUSTED',
      resultBalance: '100.00',
    });
    expect(await context.transactionOutboxTypes(id)).toEqual([
      'WagerTransactionFailed',
    ]);
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(0);
    const module = await Test.createTestingModule({
      controllers: [WageringController],
      providers: [
        {
          provide: ProcessWagerTransactionUseCase,
          useValue: context.createUseCase(),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const response = await fetch(
      `${await app.getUrl()}/wagering/transactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      transactionId: id,
      status: 'FAILED',
      idempotentReplay: true,
    });
    await context.publisher().execute();
    expect(
      (await context.events()).filter(
        (event) => event.eventType === 'WagerTransactionFailed',
      ),
    ).toHaveLength(1);
    const [mutation] = await Promise.allSettled([
      context
        .connection()
        .execute(
          `update "${context.schemaName}".wager_transactions set status = 'PROCESSED', failure_code = null, processed_at = now() where id = ?`,
          [id],
        ),
    ]);
    expect(mutation?.status).toBe('rejected');
    await context.expectReconciled(wallet.id);
  });

  it('corrida entre falha terminal e processamento normal preserva o vencedor', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      player,
      '10.00',
    );
    const results = await Promise.all([
      context.createUseCase().execute(input),
      context.createUseCase().failAfterRetries(input, {
        consumerName: 'final',
        messageId: randomUUID(),
        payloadHash: 'a'.repeat(64),
      }),
    ]);
    expect(results[0].transactionId).toBe(results[1].transactionId);
    expect(results[0].status).toBe(results[1].status);
    const processed = results[0].status === WagerTransactionStatus.Processed;
    expect(await context.walletState(wallet.id)).toMatchObject({
      balance: processed ? '90.00' : '100.00',
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Bet),
    ).toBe(processed ? 1 : 0);
    await context.expectReconciled(wallet.id);
  });

  it('aplica política de moedas no domínio e no schema', async () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      const wallet = await context.openWallet(randomUUID(), '1.00', currency);
      await context.expectReconciled(wallet.id);
    }
    const [domain] = await Promise.allSettled([
      context.openWallet(randomUUID(), '1.00', 'XYZ'),
    ]);
    expect(domain?.status).toBe('rejected');
    const [database] = await Promise.allSettled([
      context
        .connection()
        .execute(
          `insert into "${context.schemaName}".wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'XYZ', 0, 1, now(), now())`,
          [randomUUID(), randomUUID()],
        ),
    ]);
    expect(database?.status).toBe('rejected');
  });

  it('recupera scheduler morto e três processos resolvem uma referência fora de ordem', async () => {
    const player = randomUUID();
    const wallet = await context.openWallet(player, '100.00');
    const reference = randomUUID();
    const input = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      player,
      '25.00',
      { referenceExternalTransactionId: reference },
    );
    const pending = await context.createUseCase().execute(input);
    const dead = schedulerWorker(pending.transactionId, true);
    const [exit, output] = await Promise.all([
      dead.exited,
      new Response(dead.stdout).text(),
    ]);
    expect(exit).not.toBe(0);
    expect(output).toContain('REFERENCE_RETRY_COMMITTED');
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      { status: 'PENDING_REFERENCE', referenceAttempts: 1 },
    );
    await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Bet,
          wallet.id,
          player,
          '25.00',
          { externalTransactionId: reference },
        ),
      );
    const workers = Array.from({ length: 3 }, () =>
      schedulerWorker(pending.transactionId),
    );
    const results = await Promise.all(
      workers.map(async (worker) => {
        const [code, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ]);
        if (code !== 0) throw new Error(stderr);
        return JSON.parse(stdout) as { processed: number; calls: number };
      }),
    );
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1);
    expect(results.every((result) => result.calls > 0)).toBe(true);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 3,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Refund),
    ).toBe(1);
    const replay = await context.createUseCase().execute(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    await context.expectReconciled(wallet.id);
  }, 20000);
});

function schedulerWorker(
  transactionId: string,
  crash = false,
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./fixtures/reference-scheduler-worker.ts', import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        REFERENCE_TEST_SCHEMA: context.schemaName,
        REFERENCE_TEST_ID: transactionId,
        REFERENCE_TEST_CRASH: String(crash),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
