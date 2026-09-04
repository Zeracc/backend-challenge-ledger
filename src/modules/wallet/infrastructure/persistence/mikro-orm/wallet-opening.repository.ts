import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletOpeningBundle } from '../../../application/ports/wallet-opening.repository.js';
import type { WalletOpeningRepository } from '../../../application/ports/wallet-opening.repository.js';
import {
  IncompleteWalletOpeningBundleError,
  WalletAlreadyExistsError,
} from '../../../domain/errors/wallet.errors.js';
import { OutboxMessageRecord } from './entities/outbox-message.record.js';
import { WagerTransactionRecord } from './entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './entities/wallet.record.js';

export class MikroOrmWalletOpeningRepository implements WalletOpeningRepository {
  public constructor(private readonly entityManager: EntityManager) {}

  public async createAtomically(bundle: WalletOpeningBundle): Promise<void> {
    this.assertCompleteBundle(bundle);

    try {
      await this.entityManager.transactional(async (transactionManager) => {
        transactionManager.persist(new WalletRecord(bundle.wallet));
        await transactionManager.flush();

        if (
          bundle.openingTransaction !== undefined &&
          bundle.ledgerEntry !== undefined
        ) {
          transactionManager.persist(
            new WagerTransactionRecord(bundle.openingTransaction),
          );
          await transactionManager.flush();

          transactionManager.persist(
            new WalletLedgerEntryRecord(bundle.ledgerEntry),
          );
          transactionManager.persist(
            bundle.events.map((event) => new OutboxMessageRecord(event)),
          );
        }

        await transactionManager.flush();
      });
    } catch (error: unknown) {
      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes('wallets_player_currency_unique')
      ) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }

  private assertCompleteBundle(bundle: WalletOpeningBundle): void {
    const hasPositiveBalance = bundle.wallet.balance.isPositive();
    const hasCompleteOpening =
      bundle.openingTransaction !== undefined &&
      bundle.ledgerEntry !== undefined &&
      bundle.events.length === 2;
    const hasEmptyOpening =
      bundle.openingTransaction === undefined &&
      bundle.ledgerEntry === undefined &&
      bundle.events.length === 0;

    if (
      (hasPositiveBalance && !hasCompleteOpening) ||
      (!hasPositiveBalance && !hasEmptyOpening)
    ) {
      throw new IncompleteWalletOpeningBundleError();
    }
  }
}
