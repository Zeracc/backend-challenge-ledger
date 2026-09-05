import type { Clock } from '../../../../shared/application/ports/clock.js';
import type { IdGenerator } from '../../../../shared/application/ports/id-generator.js';
import type { PayloadHasher } from '../../../../shared/application/ports/payload-hasher.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateExternalTransactionProps,
} from '../../domain/entities/wager-transaction.js';
import { Money, type MoneyProps } from '../../domain/value-objects/money.js';
import type {
  ProcessWagerTransactionResult,
  WagerTransactionProcessor,
} from '../ports/wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from '../pending-reference-retry-policy.js';
import type { InboxIdentity } from '../../domain/entities/inbox-message.js';

export type ProcessableWagerTransactionKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund
  | WagerTransactionKind.Rollback;

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ProcessableWagerTransactionKind;
  referenceExternalTransactionId?: string;
  money: MoneyProps;
}

export type ProcessWagerTransactionOutput = ProcessWagerTransactionResult;

export class ProcessWagerTransactionUseCase {
  public constructor(
    private readonly processor: WagerTransactionProcessor,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly payloadHasher: PayloadHasher,
    private readonly pendingReferenceRetryPolicy = new PendingReferenceRetryPolicy(),
  ) {}

  public execute(
    input: ProcessWagerTransactionInput,
    inbox?: InboxIdentity,
  ): Promise<ProcessWagerTransactionOutput> {
    return this.process(input, inbox, false);
  }

  public failAfterRetries(
    input: ProcessWagerTransactionInput,
    inbox: InboxIdentity,
  ): Promise<ProcessWagerTransactionOutput> {
    return this.process(input, inbox, true);
  }

  private async process(
    input: ProcessWagerTransactionInput,
    inbox: InboxIdentity | undefined,
    terminalFailure: boolean,
  ): Promise<ProcessWagerTransactionOutput> {
    const money = Money.from(input.money);
    const occurredAt = this.clock.now();
    const payloadHash = this.payloadHasher.hash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      ...(input.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }),
      money: money.toJSON(),
    });
    const props: CreateExternalTransactionProps = {
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      ...(input.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }),
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      money,
      createdAt: occurredAt,
    };
    const transaction = createTransaction(input.kind, props);

    return this.processor.processAtomically({
      ...(terminalFailure ? { terminalFailure: true } : {}),
      ...(inbox === undefined ? {} : { inbox }),
      transaction,
      ledgerEntryId: this.idGenerator.generate(),
      processedEventId: this.idGenerator.generate(),
      rejectedEventId: this.idGenerator.generate(),
      balanceChangedEventId: this.idGenerator.generate(),
      occurredAt,
      referenceExpiresAt:
        this.pendingReferenceRetryPolicy.expiresAt(occurredAt),
    });
  }
}

function createTransaction(
  kind: ProcessableWagerTransactionKind,
  props: CreateExternalTransactionProps,
): WagerTransaction {
  switch (kind) {
    case WagerTransactionKind.Bet:
      return WagerTransaction.createBet(props);
    case WagerTransactionKind.Win:
      return WagerTransaction.createWin(props);
    case WagerTransactionKind.Loss:
      return WagerTransaction.createLoss(props);
    case WagerTransactionKind.Refund:
      return WagerTransaction.createRefund(props);
    case WagerTransactionKind.Rollback:
      return WagerTransaction.createRollback(props);
  }
}
