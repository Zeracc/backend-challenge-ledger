import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  WagerTransactionProcessor,
} from '../../../application/ports/wager-transaction.processor.js';
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
  WalletBalanceChangedEvent,
} from '../../../domain/events/wallet.events.js';
import { Money } from '../../../domain/value-objects/money.js';
import { OutboxMessageRecord } from './entities/outbox-message.record.js';
import { WagerTransactionRecord } from './entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './entities/wallet.record.js';

export class MikroOrmWagerTransactionProcessor implements WagerTransactionProcessor {
  public constructor(private readonly entityManager: EntityManager) {}

  public async processAtomically(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const external = requireExternalIdentity(command.transaction);

    try {
      return await this.entityManager.transactional((transactionManager) =>
        this.processWithinTransaction(transactionManager, command),
      );
    } catch (error: unknown) {
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

    entityManager.persist(new WagerTransactionRecord(transaction));
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

    transaction.markPendingReference(wallet.balance);
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

    entityManager.persist(new WagerTransactionRecord(transaction));
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
}

interface ExternalIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
}

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
