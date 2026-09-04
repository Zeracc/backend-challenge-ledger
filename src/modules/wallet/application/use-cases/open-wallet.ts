import type { Clock } from '../../../../shared/application/ports/clock.js';
import type { IdGenerator } from '../../../../shared/application/ports/id-generator.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry.js';
import { Wallet } from '../../domain/entities/wallet.js';
import {
  WagerTransactionProcessedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/wallet.events.js';
import { Money, type MoneyProps } from '../../domain/value-objects/money.js';
import type {
  WalletOpeningBundle,
  WalletOpeningRepository,
} from '../ports/wallet-opening.repository.js';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  public constructor(
    private readonly repository: WalletOpeningRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    const initialBalance = Money.from(input.initialBalance);
    const occurredAt = this.clock.now();
    const wallet = Wallet.open({
      id: this.idGenerator.generate(),
      playerId: input.playerId,
      initialBalance,
      openedAt: occurredAt,
    });

    const bundle = initialBalance.isZero()
      ? this.createEmptyOpeningBundle(wallet)
      : this.createPositiveOpeningBundle(wallet, occurredAt);

    await this.repository.createAtomically(bundle);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private createEmptyOpeningBundle(wallet: Wallet): WalletOpeningBundle {
    return { wallet, events: [] };
  }

  private createPositiveOpeningBundle(
    wallet: Wallet,
    occurredAt: Date,
  ): WalletOpeningBundle {
    const openingTransaction = WagerTransaction.createOpening({
      id: this.idGenerator.generate(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      createdAt: occurredAt,
    });
    const balanceBefore = Money.zero(wallet.currency);
    const ledgerEntry = WalletLedgerEntry.create({
      id: this.idGenerator.generate(),
      walletId: wallet.id,
      transactionId: openingTransaction.id,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: occurredAt,
    });
    const transactionEvent = new WagerTransactionProcessedEvent({
      eventId: this.idGenerator.generate(),
      aggregateId: openingTransaction.id,
      correlationId: openingTransaction.id,
      occurredAt,
      data: {
        transactionId: openingTransaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: openingTransaction.kind,
        money: wallet.balance.toJSON(),
        balanceAfter: wallet.balance.toJSON(),
      },
    });
    const balanceEvent = new WalletBalanceChangedEvent({
      eventId: this.idGenerator.generate(),
      aggregateId: wallet.id,
      correlationId: openingTransaction.id,
      occurredAt,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: openingTransaction.id,
        direction: ledgerEntry.direction,
        money: ledgerEntry.money.toJSON(),
        balanceBefore: balanceBefore.toJSON(),
        balanceAfter: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });

    return {
      wallet,
      openingTransaction,
      ledgerEntry,
      events: [transactionEvent, balanceEvent],
    };
  }
}
