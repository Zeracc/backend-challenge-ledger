import type { Clock } from '../../../../shared/application/ports/clock.js';
import type { IdGenerator } from '../../../../shared/application/ports/id-generator.js';
import type { PayloadHasher } from '../../../../shared/application/ports/payload-hasher.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { Money, type MoneyProps } from '../../domain/value-objects/money.js';
import type {
  BetTransactionProcessor,
  ProcessBetResult,
} from '../ports/bet-transaction.processor.js';

export interface ProcessBetInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: MoneyProps;
}

export type ProcessBetOutput = ProcessBetResult;

export class ProcessBetUseCase {
  public constructor(
    private readonly processor: BetTransactionProcessor,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly payloadHasher: PayloadHasher,
  ) {}

  public async execute(input: ProcessBetInput): Promise<ProcessBetOutput> {
    const money = Money.from(input.money);
    const occurredAt = this.clock.now();
    const payloadHash = this.payloadHasher.hash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: 'BET',
      money: money.toJSON(),
    });
    const transaction = WagerTransaction.createBet({
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      money,
      createdAt: occurredAt,
    });

    return this.processor.processAtomically({
      transaction,
      ledgerEntryId: this.idGenerator.generate(),
      processedEventId: this.idGenerator.generate(),
      rejectedEventId: this.idGenerator.generate(),
      balanceChangedEventId: this.idGenerator.generate(),
      occurredAt,
    });
  }
}
