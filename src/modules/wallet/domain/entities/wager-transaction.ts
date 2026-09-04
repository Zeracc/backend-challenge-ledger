import {
  InvalidOpeningTransactionError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../errors/wallet.errors.js';
import type { Money } from '../value-objects/money.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum WagerFailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface CreateBetTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: Money;
  resultBalance?: Money;
  failureCode?: WagerFailureCode;
  createdAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string | undefined,
    public readonly externalTransactionId: string | undefined,
    public readonly idempotencyKey: string | undefined,
    public readonly payloadHash: string | undefined,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    private currentStatus: WagerTransactionStatus,
    private currentResultBalance: Money | undefined,
    private currentFailureCode: WagerFailureCode | undefined,
    private readonly creationDate: Date,
    private processingDate: Date | undefined,
  ) {}

  public static createOpening(
    props: CreateOpeningTransactionProps,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidOpeningTransactionError();
    }

    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      WagerTransactionStatus.Processed,
      props.money,
      undefined,
      new Date(props.createdAt.getTime()),
      new Date(props.createdAt.getTime()),
    );
  }

  public static createBet(props: CreateBetTransactionProps): WagerTransaction {
    WagerTransaction.assertRequiredBetFields(props);

    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'BET exige um valor monetário positivo',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      WagerTransactionKind.Bet,
      props.money,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      new Date(props.createdAt.getTime()),
      undefined,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.status,
      state.resultBalance,
      state.failureCode,
      new Date(state.createdAt.getTime()),
      state.processedAt === undefined
        ? undefined
        : new Date(state.processedAt.getTime()),
    );
  }

  public get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  public get resultBalance(): Money | undefined {
    return this.currentResultBalance;
  }

  public get failureCode(): WagerFailureCode | undefined {
    return this.currentFailureCode;
  }

  public get createdAt(): Date {
    return new Date(this.creationDate.getTime());
  }

  public get processedAt(): Date | undefined {
    return this.processingDate === undefined
      ? undefined
      : new Date(this.processingDate.getTime());
  }

  public markProcessed(balanceAfter: Money, at: Date): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balanceAfter);
    this.currentStatus = WagerTransactionStatus.Processed;
    this.currentResultBalance = balanceAfter;
    this.processingDate = new Date(at.getTime());
  }

  public reject(code: WagerFailureCode, balance: Money): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balance);
    this.currentStatus = WagerTransactionStatus.Rejected;
    this.currentFailureCode = code;
    this.currentResultBalance = balance;
  }

  public isTerminal(): boolean {
    return (
      this.currentStatus === WagerTransactionStatus.Processed ||
      this.currentStatus === WagerTransactionStatus.Rejected ||
      this.currentStatus === WagerTransactionStatus.Failed
    );
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError();
    }
  }

  private assertResultCurrency(balance: Money): void {
    if (this.money.currency !== balance.currency) {
      throw new InvalidWagerTransactionError(
        'o saldo resultante deve usar a moeda da transação',
      );
    }
  }

  private static assertRequiredBetFields(
    props: CreateBetTransactionProps,
  ): void {
    const boundedFields: ReadonlyArray<readonly [string, number]> = [
      [props.id, 100],
      [props.providerId, 100],
      [props.externalTransactionId, 150],
      [props.idempotencyKey, 200],
      [props.walletId, 100],
      [props.playerId, 100],
      [props.roundId, 150],
      [props.gameId, 150],
    ];

    if (
      boundedFields.some(
        ([value, maximum]) =>
          value.trim().length === 0 || value.length > maximum,
      ) ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash)
    ) {
      throw new InvalidWagerTransactionError(
        'os campos de identidade ou o payload hash são inválidos',
      );
    }
  }
}
