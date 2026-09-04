import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  BetTransactionProcessor,
  ProcessBetCommand,
  ProcessBetResult,
} from '../../../application/ports/bet-transaction.processor.js';
import {
  WagerFailureCode,
  type WagerTransaction,
  type WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.js';
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
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../../domain/events/wallet.events.js';
import { Money } from '../../../domain/value-objects/money.js';
import { OutboxMessageRecord } from './entities/outbox-message.record.js';
import { WagerTransactionRecord } from './entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './entities/wallet.record.js';

export class MikroOrmBetTransactionProcessor implements BetTransactionProcessor {
  public constructor(private readonly entityManager: EntityManager) {}

  public async processAtomically(
    command: ProcessBetCommand,
  ): Promise<ProcessBetResult> {
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
    command: ProcessBetCommand,
  ): Promise<ProcessBetResult> {
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

    try {
      const debitedWallet = wallet.debit(transaction.money, command.occurredAt);
      transaction.markProcessed(debitedWallet.balance, command.occurredAt);
      walletRecord.apply(debitedWallet);

      const ledgerEntry = WalletLedgerEntry.create({
        id: command.ledgerEntryId,
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: LedgerDirection.Debit,
        money: transaction.money,
        balanceBefore: wallet.balance,
        balanceAfter: debitedWallet.balance,
        createdAt: command.occurredAt,
      });
      const processedEvent = new WagerTransactionProcessedEvent({
        eventId: command.processedEventId,
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
          balanceAfter: debitedWallet.balance.toJSON(),
        },
      });
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
          walletVersion: debitedWallet.version,
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
    } catch (error: unknown) {
      if (!(error instanceof InsufficientWalletFundsError)) {
        throw error;
      }

      transaction.reject(WagerFailureCode.InsufficientFunds, wallet.balance);
      const rejectedEvent = new WagerTransactionRejectedEvent({
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
          failureCode: WagerFailureCode.InsufficientFunds,
        },
      });

      entityManager.persist(new WagerTransactionRecord(transaction));
      entityManager.persist(new OutboxMessageRecord(rejectedEvent));
      await entityManager.flush();

      return resultFromTransaction(transaction, false);
    }
  }

  private resolveReplay(
    record: WagerTransactionRecord,
    payloadHash: string | undefined,
  ): ProcessBetResult {
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
    throw new Error('O processador BET recebeu uma transação interna.');
  }

  return {
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
  };
}

function resultFromTransaction(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): ProcessBetResult {
  const balance = transaction.resultBalance;

  if (balance === undefined) {
    throw new Error('A transação terminal não possui saldo resultante.');
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
