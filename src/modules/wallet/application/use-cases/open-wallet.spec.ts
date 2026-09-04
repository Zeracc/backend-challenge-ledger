import { describe, expect, it } from 'bun:test';

import type { Clock } from '../../../../shared/application/ports/clock.js';
import type { IdGenerator } from '../../../../shared/application/ports/id-generator.js';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry.js';
import type {
  WalletOpeningBundle,
  WalletOpeningRepository,
} from '../ports/wallet-opening.repository.js';
import { OpenWalletUseCase } from './open-wallet.js';

const occurredAt = new Date('2026-09-04T12:00:00.000Z');

describe('OpenWalletUseCase', () => {
  it('persiste somente a wallet quando o saldo inicial é zero', async () => {
    const repository = new RecordingWalletOpeningRepository();
    const useCase = createUseCase(repository, ['wallet-id']);

    const result = await useCase.execute({
      playerId: 'player-id',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(result).toEqual({
      id: 'wallet-id',
      playerId: 'player-id',
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(repository.bundle?.openingTransaction).toBeUndefined();
    expect(repository.bundle?.ledgerEntry).toBeUndefined();
    expect(repository.bundle?.events).toEqual([]);
  });

  it('persiste OPENING, ledger e outbox junto à wallet com saldo positivo', async () => {
    const repository = new RecordingWalletOpeningRepository();
    const useCase = createUseCase(repository, [
      'wallet-id',
      'transaction-id',
      'ledger-id',
      'transaction-event-id',
      'balance-event-id',
    ]);

    await useCase.execute({
      playerId: 'player-id',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bundle = repository.bundle;

    expect(bundle?.openingTransaction?.kind).toBe(WagerTransactionKind.Opening);
    expect(bundle?.openingTransaction?.money.toString()).toBe('100.00');
    expect(bundle?.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(bundle?.ledgerEntry?.isBalanced()).toBe(true);
    expect(bundle?.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });
});

class RecordingWalletOpeningRepository implements WalletOpeningRepository {
  public bundle: WalletOpeningBundle | undefined;

  public createAtomically(bundle: WalletOpeningBundle): Promise<void> {
    this.bundle = bundle;

    return Promise.resolve();
  }
}

class SequenceIdGenerator implements IdGenerator {
  public constructor(private readonly ids: string[]) {}

  public generate(): string {
    const id = this.ids.shift();

    if (id === undefined) {
      throw new Error('A sequência de IDs de teste foi esgotada.');
    }

    return id;
  }
}

function createUseCase(
  repository: WalletOpeningRepository,
  ids: string[],
): OpenWalletUseCase {
  const clock: Clock = { now: () => new Date(occurredAt) };

  return new OpenWalletUseCase(repository, new SequenceIdGenerator(ids), clock);
}
