import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  PendingReferenceProcessor,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  ReprocessPendingReferencesCommand,
  ReprocessPendingReferencesResult,
  WagerTransactionProcessor,
} from '../../../application/ports/wager-transaction.processor.js';
import type { IdGenerator } from '../../../../../shared/application/ports/id-generator.js';
import { UuidGenerator } from '../../../../../shared/infrastructure/system/uuid-generator.js';
import {
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../../domain/entities/wager-transaction.js';
import type { Wallet } from '../../../domain/entities/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/entities/wallet-ledger-entry.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InsufficientWalletFundsError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../../domain/errors/wallet.errors.js';
import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WagerTransactionFailedEvent,
  WalletBalanceChangedEvent,
} from '../../../domain/events/wallet.events.js';
import { Money } from '../../../domain/value-objects/money.js';
import { OutboxMessageRecord } from './entities/outbox-message.record.js';
import { WagerTransactionRecord } from './entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './entities/wallet.record.js';
import { InboxMessage } from '../../../domain/entities/inbox-message.js';
import { InboxMessageRecord } from './entities/inbox-message.record.js';

export class MikroOrmWagerTransactionProcessor
  implements WagerTransactionProcessor, PendingReferenceProcessor
{
  public constructor(
    private readonly entityManager: EntityManager,
    private readonly idGenerator: IdGenerator = new UuidGenerator(),
  ) {}

  public async processAtomically(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const external = requireExternalIdentity(command.transaction);

    try {
      return await this.entityManager
        .fork()
        .transactional((transactionManager) =>
          this.processWithInbox(transactionManager, command),
        );
    } catch (error: unknown) {
      if (
        command.inbox !== undefined &&
        error instanceof UniqueConstraintViolationException &&
        (error.message.includes('inbox_messages_pkey') ||
          error.message.includes('wager_transactions_idempotency_key_unique'))
      ) {
        // A escrita vencedora já confirmou antes de a violação de unicidade retornar.
        // Repetir a transação inteira também confirma a Inbox do replay.
        return this.entityManager
          .fork()
          .transactional((em) => this.processWithInbox(em, command));
      }
      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes('wager_transactions_idempotency_key_unique')
      ) {
        const existing = await this.entityManager
          .fork()
          .findOne(WagerTransactionRecord, {
            idempotencyKey: external.idempotencyKey,
          });

        if (existing !== null) {
          return this.resolveReplay(existing, external.payloadHash);
        }
      }

      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes('wager_transactions_provider_external_unique')
      ) {
        throw new ExternalTransactionConflictError();
      }

      throw error;
    }
  }

  private async processWithInbox(
    em: EntityManager,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    if (command.inbox === undefined)
      return this.processWithinTransaction(em, command);
    await em.execute("set local lock_timeout = '5s'");
    await em.execute("set local statement_timeout = '10s'");
    const identity = command.inbox;
    let record = await em.findOne(
      InboxMessageRecord,
      { consumerName: identity.consumerName, messageId: identity.messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const message =
      record?.toDomain() ??
      InboxMessage.receive({ ...identity, receivedAt: command.occurredAt });
    message.assertPayload(identity.payloadHash);
    if (record === null) {
      record = new InboxMessageRecord(message);
      em.persist(record);
      await em.flush();
    }
    const result = await this.processWithinTransaction(em, command);
    if (!message.isProcessed()) {
      message.markProcessed(result.transactionId, command.occurredAt);
      record.apply(message);
      await em.flush();
    }
    return result;
  }

  public async reprocessDue(
    command: ReprocessPendingReferencesCommand,
  ): Promise<ReprocessPendingReferencesResult> {
    const candidates = await this.entityManager.fork().find(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: command.occurredAt },
      },
      {
        limit: command.batchSize,
        orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' },
      },
    );
    const result: ReprocessPendingReferencesResult = {
      scanned: candidates.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
    };

    const errors: unknown[] = [];
    for (const candidate of candidates) {
      try {
        const outcome = await this.entityManager
          .fork()
          .transactional((transactionManager) =>
            this.reprocessPendingReferenceWithinTransaction(
              transactionManager,
              candidate.id,
              command,
            ),
          );

        if (outcome === 'PROCESSED') {
          result.processed += 1;
        } else if (outcome === 'REJECTED') {
          result.rejected += 1;
        } else if (outcome === 'RESCHEDULED') {
          result.rescheduled += 1;
        }
      } catch (error: unknown) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Falha ao reprocessar referências; os demais itens do lote foram tentados.',
      );
    }

    return result;
  }

  private async reprocessPendingReferenceWithinTransaction(
    entityManager: EntityManager,
    transactionId: string,
    command: ReprocessPendingReferencesCommand,
  ): Promise<PendingReferenceReprocessOutcome> {
    const record = await entityManager.findOne(
      WagerTransactionRecord,
      { id: transactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (record === null) {
      return 'SKIPPED';
    }

    const transaction = record.toDomain();

    if (!transaction.isReferenceDue(command.occurredAt)) {
      return 'SKIPPED';
    }

    const external = requireExternalIdentity(transaction);
    const walletRecord = await entityManager.findOne(
      WalletRecord,
      { id: transaction.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (walletRecord === null) {
      throw new WalletNotFoundError();
    }

    const wallet = walletRecord.toDomain();
    const reference = await this.findReference(entityManager, transaction);
    const processingCommand = this.createReprocessingCommand(
      transaction,
      command.occurredAt,
    );

    if (reference === undefined) {
      if (
        transaction.hasReferenceRetryExpired(
          command.occurredAt,
          command.maximumAttempts,
        )
      ) {
        await this.processRejected(
          entityManager,
          wallet,
          processingCommand,
          external,
          WagerFailureCode.ReferenceNotFound,
          undefined,
          record,
        );
        return 'REJECTED';
      }

      transaction.scheduleReferenceRetry(
        calculateNextReferenceAttemptAt(
          command.occurredAt,
          transaction.referenceAttempts + 1,
          command,
        ),
      );
      record.apply(transaction);
      await entityManager.flush();
      return 'RESCHEDULED';
    }

    const referenceFailure = transaction.referenceFailureFor(reference);

    if (referenceFailure !== undefined) {
      await this.processRejected(
        entityManager,
        wallet,
        processingCommand,
        external,
        referenceFailure,
        reference.id,
        record,
      );
      return 'REJECTED';
    }

    if (
      isReversal(transaction.kind) &&
      (await this.hasProcessedReversal(
        entityManager,
        reference.id,
        transaction.kind,
      ))
    ) {
      await this.processRejected(
        entityManager,
        wallet,
        processingCommand,
        external,
        WagerFailureCode.DuplicateReversal,
        reference.id,
        record,
      );
      return 'REJECTED';
    }

    switch (transaction.kind) {
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        await this.processBalanceChange(
          entityManager,
          walletRecord,
          wallet,
          wallet.credit(transaction.money, command.occurredAt),
          LedgerDirection.Credit,
          processingCommand,
          external,
          reference,
          record,
        );
        return 'PROCESSED';
      case WagerTransactionKind.Rollback: {
        const result = await this.processRollback(
          entityManager,
          walletRecord,
          wallet,
          processingCommand,
          external,
          reference,
          record,
        );
        return result.status === WagerTransactionStatus.Rejected
          ? 'REJECTED'
          : 'PROCESSED';
      }
      default:
        throw new Error(
          `A transação pendente ${transaction.kind} não suporta referência.`,
        );
    }
  }

  private createReprocessingCommand(
    transaction: WagerTransaction,
    occurredAt: Date,
  ): ProcessWagerTransactionCommand {
    return {
      transaction,
      ledgerEntryId: this.idGenerator.generate(),
      processedEventId: this.idGenerator.generate(),
      rejectedEventId: this.idGenerator.generate(),
      balanceChangedEventId: this.idGenerator.generate(),
      occurredAt,
      referenceExpiresAt:
        transaction.referenceExpiresAt === undefined
          ? occurredAt
          : transaction.referenceExpiresAt,
    };
  }

  private async processWithinTransaction(
    entityManager: EntityManager,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = command.transaction;
    const external = requireExternalIdentity(transaction);
    const existingBeforeLock = await entityManager.findOne(
      WagerTransactionRecord,
      { idempotencyKey: external.idempotencyKey },
    );

    if (existingBeforeLock !== null) {
      return this.resolveReplay(existingBeforeLock, external.payloadHash);
    }

    const walletRecord = await entityManager.findOne(
      WalletRecord,
      { id: transaction.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (walletRecord === null) {
      throw new WalletNotFoundError();
    }

    const existingAfterLock = await entityManager.findOne(
      WagerTransactionRecord,
      { idempotencyKey: external.idempotencyKey },
    );

    if (existingAfterLock !== null) {
      return this.resolveReplay(existingAfterLock, external.payloadHash);
    }

    if (walletRecord.playerId !== transaction.playerId) {
      throw new WalletPlayerMismatchError();
    }

    if (walletRecord.currency !== transaction.money.currency) {
      throw new WalletCurrencyMismatchError(
        walletRecord.currency,
        transaction.money.currency,
      );
    }

    const duplicateExternal = await entityManager.findOne(
      WagerTransactionRecord,
      {
        providerId: external.providerId,
        externalTransactionId: external.externalTransactionId,
      },
    );

    if (duplicateExternal !== null) {
      throw new ExternalTransactionConflictError();
    }

    const wallet = walletRecord.toDomain();
    if (command.terminalFailure) {
      transaction.fail(wallet.balance);
      const event = new WagerTransactionFailedEvent({
        eventId: command.rejectedEventId,
        aggregateId: transaction.id,
        correlationId: transaction.id,
        occurredAt: command.occurredAt,
        data: {
          transactionId: transaction.id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: external.providerId,
          externalTransactionId: external.externalTransactionId,
          kind: transaction.kind,
          money: transaction.money.toJSON(),
          balance: wallet.balance.toJSON(),
          failureCode: WagerFailureCode.ProcessingAttemptsExhausted,
        },
      });
      entityManager.persist([
        new WagerTransactionRecord(transaction),
        new OutboxMessageRecord(event),
      ]);
      await entityManager.flush();
      return resultFromTransaction(transaction, false);
    }
    const reference = await this.findReference(entityManager, transaction);

    if (
      transaction.referenceExternalTransactionId !== undefined &&
      reference === undefined
    ) {
      return this.processPendingReference(
        entityManager,
        wallet,
        command,
        external,
      );
    }

    if (reference !== undefined) {
      const referenceFailure = transaction.referenceFailureFor(reference);

      if (referenceFailure !== undefined) {
        return this.processRejected(
          entityManager,
          wallet,
          command,
          external,
          referenceFailure,
          reference.id,
        );
      }

      if (
        isReversal(transaction.kind) &&
        (await this.hasProcessedReversal(
          entityManager,
          reference.id,
          transaction.kind,
        ))
      ) {
        return this.processRejected(
          entityManager,
          wallet,
          command,
          external,
          WagerFailureCode.DuplicateReversal,
          reference.id,
        );
      }
    }

    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        return this.processDebit(
          entityManager,
          walletRecord,
          wallet,
          command,
          external,
          WagerFailureCode.InsufficientFunds,
        );
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return this.processBalanceChange(
          entityManager,
          walletRecord,
          wallet,
          wallet.credit(transaction.money, command.occurredAt),
          LedgerDirection.Credit,
          command,
          external,
          reference,
        );
      case WagerTransactionKind.Loss:
        return this.processLoss(entityManager, wallet, command, external);
      case WagerTransactionKind.Rollback:
        return this.processRollback(
          entityManager,
          walletRecord,
          wallet,
          command,
          external,
          requireReference(reference),
        );
      default:
        throw new Error(
          `O processador não suporta transações ${transaction.kind}.`,
        );
    }
  }

  private async findReference(
    entityManager: EntityManager,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    if (transaction.referenceExternalTransactionId === undefined) {
      return undefined;
    }

    const record = await entityManager.findOne(WagerTransactionRecord, {
      providerId: transaction.providerId,
      externalTransactionId: transaction.referenceExternalTransactionId,
    });

    return record?.toDomain();
  }

  private async hasProcessedReversal(
    entityManager: EntityManager,
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    return (
      (await entityManager.findOne(WagerTransactionRecord, {
        referenceTransactionId,
        kind,
        status: WagerTransactionStatus.Processed,
      })) !== null
    );
  }

  private async processRollback(
    entityManager: EntityManager,
    walletRecord: WalletRecord,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
    reference: WagerTransaction,
    existingTransactionRecord?: WagerTransactionRecord,
  ): Promise<ProcessWagerTransactionResult> {
    if (reference.kind === WagerTransactionKind.Bet) {
      return this.processBalanceChange(
        entityManager,
        walletRecord,
        wallet,
        wallet.credit(command.transaction.money, command.occurredAt),
        LedgerDirection.Credit,
        command,
        external,
        reference,
        existingTransactionRecord,
      );
    }

    return this.processDebit(
      entityManager,
      walletRecord,
      wallet,
      command,
      external,
      WagerFailureCode.RollbackInsufficientFunds,
      reference,
      existingTransactionRecord,
    );
  }

  private async processDebit(
    entityManager: EntityManager,
    walletRecord: WalletRecord,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
    insufficientFundsCode: WagerFailureCode,
    reference?: WagerTransaction,
    existingTransactionRecord?: WagerTransactionRecord,
  ): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.processBalanceChange(
        entityManager,
        walletRecord,
        wallet,
        wallet.debit(command.transaction.money, command.occurredAt),
        LedgerDirection.Debit,
        command,
        external,
        reference,
        existingTransactionRecord,
      );
    } catch (error: unknown) {
      if (!(error instanceof InsufficientWalletFundsError)) {
        throw error;
      }

      return this.processRejected(
        entityManager,
        wallet,
        command,
        external,
        insufficientFundsCode,
        reference?.id,
        existingTransactionRecord,
      );
    }
  }

  private async processBalanceChange(
    entityManager: EntityManager,
    walletRecord: WalletRecord,
    wallet: Wallet,
    updatedWallet: Wallet,
    direction: LedgerDirection,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
    reference?: WagerTransaction,
    existingTransactionRecord?: WagerTransactionRecord,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = command.transaction;
    transaction.markProcessed(
      updatedWallet.balance,
      command.occurredAt,
      reference?.id,
    );
    walletRecord.apply(updatedWallet);

    const ledgerEntry = WalletLedgerEntry.create({
      id: command.ledgerEntryId,
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money: transaction.money,
      balanceBefore: wallet.balance,
      balanceAfter: updatedWallet.balance,
      createdAt: command.occurredAt,
    });
    const processedEvent = createProcessedEvent(
      transaction,
      wallet,
      external,
      command.processedEventId,
      command.occurredAt,
      updatedWallet.balance,
    );
    const balanceEvent = new WalletBalanceChangedEvent({
      eventId: command.balanceChangedEventId,
      aggregateId: wallet.id,
      correlationId: transaction.id,
      occurredAt: command.occurredAt,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: transaction.id,
        direction: ledgerEntry.direction,
        money: ledgerEntry.money.toJSON(),
        balanceBefore: ledgerEntry.balanceBefore.toJSON(),
        balanceAfter: ledgerEntry.balanceAfter.toJSON(),
        walletVersion: updatedWallet.version,
      },
    });

    this.persistTransaction(
      entityManager,
      transaction,
      existingTransactionRecord,
    );
    await entityManager.flush();
    entityManager.persist(new WalletLedgerEntryRecord(ledgerEntry));
    entityManager.persist([
      new OutboxMessageRecord(processedEvent),
      new OutboxMessageRecord(balanceEvent),
    ]);
    await entityManager.flush();

    return resultFromTransaction(transaction, false);
  }

  private async processLoss(
    entityManager: EntityManager,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = command.transaction;
    transaction.markProcessed(wallet.balance, command.occurredAt);
    const processedEvent = createProcessedEvent(
      transaction,
      wallet,
      external,
      command.processedEventId,
      command.occurredAt,
      wallet.balance,
    );

    entityManager.persist(new WagerTransactionRecord(transaction));
    entityManager.persist(new OutboxMessageRecord(processedEvent));
    await entityManager.flush();

    return resultFromTransaction(transaction, false);
  }

  private async processPendingReference(
    entityManager: EntityManager,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = command.transaction;
    const referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;

    if (referenceExternalTransactionId === undefined) {
      throw new Error('A transação pendente não possui referência externa.');
    }

    transaction.markPendingReference(
      wallet.balance,
      command.occurredAt,
      command.referenceExpiresAt,
    );
    const event = new WagerTransactionPendingReferenceEvent({
      eventId: command.rejectedEventId,
      aggregateId: transaction.id,
      correlationId: transaction.id,
      occurredAt: command.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: external.providerId,
        externalTransactionId: external.externalTransactionId,
        referenceExternalTransactionId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
      },
    });

    entityManager.persist(new WagerTransactionRecord(transaction));
    entityManager.persist(new OutboxMessageRecord(event));
    await entityManager.flush();

    return resultFromTransaction(transaction, false);
  }

  private async processRejected(
    entityManager: EntityManager,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    external: ExternalIdentity,
    failureCode: WagerFailureCode,
    referenceTransactionId?: string,
    existingTransactionRecord?: WagerTransactionRecord,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = command.transaction;
    transaction.reject(failureCode, wallet.balance, referenceTransactionId);
    const event = new WagerTransactionRejectedEvent({
      eventId: command.rejectedEventId,
      aggregateId: transaction.id,
      correlationId: transaction.id,
      occurredAt: command.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: external.providerId,
        externalTransactionId: external.externalTransactionId,
        ...(transaction.referenceExternalTransactionId === undefined
          ? {}
          : {
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,
            }),
        ...(referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId }),
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        failureCode,
      },
    });

    this.persistTransaction(
      entityManager,
      transaction,
      existingTransactionRecord,
    );
    entityManager.persist(new OutboxMessageRecord(event));
    await entityManager.flush();

    return resultFromTransaction(transaction, false);
  }

  private resolveReplay(
    record: WagerTransactionRecord,
    payloadHash: string | undefined,
  ): ProcessWagerTransactionResult {
    if (record.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError();
    }

    return {
      transactionId: record.id,
      status: record.status as WagerTransactionStatus,
      balance: Money.from({
        amount: record.resultBalance,
        currency: record.resultCurrency,
      }).toJSON(),
      ...(record.failureCode == null
        ? {}
        : { failureCode: record.failureCode as WagerFailureCode }),
      idempotentReplay: true,
    };
  }

  private persistTransaction(
    entityManager: EntityManager,
    transaction: WagerTransaction,
    existingTransactionRecord?: WagerTransactionRecord,
  ): void {
    if (existingTransactionRecord !== undefined) {
      existingTransactionRecord.apply(transaction);
      return;
    }

    entityManager.persist(new WagerTransactionRecord(transaction));
  }
}

interface ExternalIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

type PendingReferenceReprocessOutcome =
  'SKIPPED' | 'PROCESSED' | 'REJECTED' | 'RESCHEDULED';

function requireExternalIdentity(
  transaction: WagerTransaction,
): ExternalIdentity {
  if (
    transaction.providerId === undefined ||
    transaction.externalTransactionId === undefined ||
    transaction.idempotencyKey === undefined ||
    transaction.payloadHash === undefined
  ) {
    throw new Error('O processador recebeu uma transação interna.');
  }

  return {
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
  };
}

function requireReference(
  reference: WagerTransaction | undefined,
): WagerTransaction {
  if (reference === undefined) {
    throw new Error('A reversão não possui uma referência resolvida.');
  }

  return reference;
}

function isReversal(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  );
}

function calculateNextReferenceAttemptAt(
  now: Date,
  attemptNumber: number,
  command: ReprocessPendingReferencesCommand,
): Date {
  const multiplier = 2 ** Math.max(0, attemptNumber - 1);
  const delayMs = Math.min(
    command.baseDelayMs * multiplier,
    command.maximumDelayMs,
  );

  return new Date(now.getTime() + delayMs);
}

function createProcessedEvent(
  transaction: WagerTransaction,
  wallet: Wallet,
  external: ExternalIdentity,
  eventId: string,
  occurredAt: Date,
  balanceAfter: Money,
): WagerTransactionProcessedEvent {
  return new WagerTransactionProcessedEvent({
    eventId,
    aggregateId: transaction.id,
    correlationId: transaction.id,
    occurredAt,
    data: {
      transactionId: transaction.id,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: external.providerId,
      externalTransactionId: external.externalTransactionId,
      ...(transaction.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
          }),
      ...(transaction.referenceTransactionId === undefined
        ? {}
        : { referenceTransactionId: transaction.referenceTransactionId }),
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balanceAfter: balanceAfter.toJSON(),
    },
  });
}

function resultFromTransaction(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): ProcessWagerTransactionResult {
  const balance = transaction.resultBalance;

  if (balance === undefined) {
    throw new Error('A transação persistida não possui saldo resultante.');
  }

  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    ...(transaction.failureCode === undefined
      ? {}
      : { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}
