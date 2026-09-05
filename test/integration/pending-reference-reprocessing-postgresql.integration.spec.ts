import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { PendingReferenceRetryPolicy } from '../../src/modules/wallet/application/pending-reference-retry-policy.js';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { ReprocessPendingReferencesUseCase } from '../../src/modules/wallet/application/use-cases/reprocess-pending-references.js';
import {
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import type { Clock } from '../../src/shared/application/ports/clock.js';
import { Sha256PayloadHasher } from '../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import {
  SequenceIdGenerator,
  WagerTestContext,
  captureRejection,
} from './support/wager-test-context.js';

const context = new WagerTestContext(
  `pending_reference_test_${randomUUID().replaceAll('-', '')}`,
);
const retryPolicy = new PendingReferenceRetryPolicy({
  maximumAttempts: 1,
  ttlMs: 60 * 60 * 1000,
  baseDelayMs: 1_000,
  maximumDelayMs: 1_000,
  batchSize: 20,
});

describe('reprocessamento de PENDING_REFERENCE com PostgreSQL', () => {
  beforeAll(async () => context.start());
  afterAll(async () => context.stop());

  it('processa REFUND pendente quando a BET referenciada chega depois', async () => {
    const at = new Date('2026-09-08T12:00:00.000Z');
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const refundInput = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      playerId,
      '25.00',
      {
        externalTransactionId: 'refund-out-of-order',
        referenceExternalTransactionId: 'bet-late',
      },
    );
    const pending = await processAt(at).execute(refundInput);
    const bet = await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '25.00',
        { externalTransactionId: 'bet-late' },
      ),
    );

    const result = await reprocessAt(at).execute();

    expect(result).toEqual({
      scanned: 1,
      processed: 1,
      rejected: 0,
      rescheduled: 0,
    });
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      {
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: bet.transactionId,
        referenceAttempts: 0,
      },
    );
    expect(await context.ledgerState(pending.transactionId)).toEqual({
      direction: 'CREDIT',
      amount: '25.00',
      balanceBefore: '75.00',
      balanceAfter: '100.00',
    });
    expect(await context.transactionOutboxTypes(pending.transactionId)).toEqual(
      [
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ],
    );
    await context.expectReconciled(wallet.id);
  });

  it('aplica backoff e rejeita referência ausente ao atingir o limite', async () => {
    const firstAt = new Date('2026-09-08T13:00:00.000Z');
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const pending = await processAt(firstAt).execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: 'bet-never-arrives' },
      ),
    );

    const rescheduled = await reprocessAt(firstAt).execute();
    const stateAfterRetry = await context.transactionState(
      pending.transactionId,
    );
    const rejected = await reprocessAt(
      new Date(firstAt.getTime() + 1_000),
    ).execute();

    expect(rescheduled).toEqual({
      scanned: 1,
      processed: 0,
      rejected: 0,
      rescheduled: 1,
    });
    expect(stateAfterRetry).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      referenceAttempts: 1,
    });
    expect(rejected).toEqual({
      scanned: 1,
      processed: 0,
      rejected: 1,
      rescheduled: 0,
    });
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      {
        status: WagerTransactionStatus.Rejected,
        failureCode: WagerFailureCode.ReferenceNotFound,
        referenceAttempts: 1,
      },
    );
    expect(await context.ledgerState(pending.transactionId)).toBeUndefined();
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 1,
    });
    await context.expectReconciled(wallet.id);
  });

  it('rejeita referência ausente quando o TTL expira antes do limite', async () => {
    const at = new Date('2026-09-08T13:30:00.000Z');
    const shortTtlPolicy = new PendingReferenceRetryPolicy({
      maximumAttempts: 8,
      ttlMs: 1_000,
      baseDelayMs: 1_000,
      maximumDelayMs: 1_000,
      batchSize: 20,
    });
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const pending = await processAt(at, shortTtlPolicy).execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: 'bet-expired-by-ttl' },
      ),
    );

    const result = await reprocessAt(
      new Date(at.getTime() + 1_000),
      shortTtlPolicy,
    ).execute();

    expect(result).toEqual({
      scanned: 1,
      processed: 0,
      rejected: 1,
      rescheduled: 0,
    });
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      {
        status: WagerTransactionStatus.Rejected,
        failureCode: WagerFailureCode.ReferenceNotFound,
        referenceAttempts: 0,
      },
    );
    await context.expectReconciled(wallet.id);
  });

  it('permite que dois workers tentem a mesma pendência sem duplicar o crédito', async () => {
    const at = new Date('2026-09-08T14:00:00.000Z');
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const refundInput = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      playerId,
      '10.00',
      {
        externalTransactionId: 'refund-concurrent',
        referenceExternalTransactionId: 'bet-concurrent',
      },
    );
    const pending = await processAt(at).execute(refundInput);
    await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '10.00',
        { externalTransactionId: 'bet-concurrent' },
      ),
    );

    const [first, second] = await Promise.all([
      reprocessAt(at).execute(),
      reprocessAt(at).execute(),
    ]);

    expect(first.processed + second.processed).toBe(1);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 3,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Refund),
    ).toBe(1);
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      {
        status: WagerTransactionStatus.Processed,
      },
    );
    await context.expectReconciled(wallet.id);
  });

  it('conta ROLLBACK pendente rejeitado por saldo como rejeição', async () => {
    const at = new Date('2026-09-08T14:30:00.000Z');
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '0.00');
    const winId = randomUUID();
    const pending = await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: winId },
      ),
    );
    await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Win,
        wallet.id,
        playerId,
        '10.00',
        { externalTransactionId: winId },
      ),
    );
    await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '10.00',
      ),
    );
    expect(await reprocessAt(at).execute()).toEqual({
      scanned: 1,
      processed: 0,
      rejected: 1,
      rescheduled: 0,
    });
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      { status: 'REJECTED', failureCode: 'ROLLBACK_INSUFFICIENT_FUNDS' },
    );
    expect(await context.ledgerState(pending.transactionId)).toBeUndefined();
    await context.expectReconciled(wallet.id);
  });

  it('mantém a pendência quando a outbox falha durante o reprocessamento', async () => {
    const at = new Date('2026-09-08T15:00:00.000Z');
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const refundInput = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      playerId,
      '25.00',
      {
        externalTransactionId: 'refund-outbox-failure',
        referenceExternalTransactionId: 'bet-outbox-failure',
      },
    );
    const pending = await processAt(at).execute(refundInput);
    await processAt(at).execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '25.00',
        { externalTransactionId: 'bet-outbox-failure' },
      ),
    );
    const existingOutboxId = await context.findOpeningOutboxId(wallet.id);
    const laterAt = new Date(at.getTime() + 1);
    const secondPending = await processAt(laterAt).execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '25.00',
        { referenceExternalTransactionId: 'second-bet-outbox-failure' },
      ),
    );
    await processAt(laterAt).execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '25.00',
        { externalTransactionId: 'second-bet-outbox-failure' },
      ),
    );
    const error = await captureRejection(
      new ReprocessPendingReferencesUseCase(
        new MikroOrmWagerTransactionProcessor(
          context.getOrm().em.fork(),
          new SequenceIdGenerator([
            randomUUID(),
            existingOutboxId,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
          ]),
        ),
        new FixedClock(laterAt),
        retryPolicy,
      ).execute(),
    );

    expect(error).toBeInstanceOf(Error);
    expect(
      await context.transactionState(secondPending.transactionId),
    ).toMatchObject({ status: 'PROCESSED' });
    expect(await context.transactionState(pending.transactionId)).toMatchObject(
      {
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: 0,
      },
    );
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 4,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Refund),
    ).toBe(1);
    await context.expectReconciled(wallet.id);
  });
});

function processAt(
  at: Date,
  policy: PendingReferenceRetryPolicy = retryPolicy,
): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    new MikroOrmWagerTransactionProcessor(context.getOrm().em.fork()),
    new UuidGenerator(),
    new FixedClock(at),
    new Sha256PayloadHasher(),
    policy,
  );
}

function reprocessAt(
  at: Date,
  policy: PendingReferenceRetryPolicy = retryPolicy,
): ReprocessPendingReferencesUseCase {
  return new ReprocessPendingReferencesUseCase(
    new MikroOrmWagerTransactionProcessor(context.getOrm().em.fork()),
    new FixedClock(at),
    policy,
  );
}

class FixedClock implements Clock {
  public constructor(private readonly at: Date) {}

  public now(): Date {
    return new Date(this.at.getTime());
  }
}
