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
  ProcessingAttemptsExhausted = 'PROCESSING_ATTEMPTS_EXHAUSTED',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  RollbackInsufficientFunds = 'ROLLBACK_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface CreateExternalTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  referenceExternalTransactionId?: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId?: string | undefined;
  externalTransactionId?: string | undefined;
  idempotencyKey?: string | undefined;
  payloadHash?: string | undefined;
  referenceExternalTransactionId?: string | undefined;
  referenceTransactionId?: string | undefined;
  referenceAttempts?: number | undefined;
  nextReferenceAttemptAt?: Date | undefined;
  referenceExpiresAt?: Date | undefined;
  walletId: string;
  playerId: string;
  roundId?: string | undefined;
  gameId?: string | undefined;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: Money;
  resultBalance?: Money | undefined;
  failureCode?: WagerFailureCode | undefined;
  createdAt: Date;
  processedAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string | undefined,
    public readonly externalTransactionId: string | undefined,
    public readonly idempotencyKey: string | undefined,
    public readonly payloadHash: string | undefined,
    public readonly referenceExternalTransactionId: string | undefined,
    private currentReferenceTransactionId: string | undefined,
    private currentReferenceAttempts: number,
    private currentNextReferenceAttemptAt: Date | undefined,
    private currentReferenceExpiresAt: Date | undefined,
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
      undefined,
      undefined,
      0,
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

  public static createBet(
    props: CreateExternalTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(props, WagerTransactionKind.Bet);
  }

  public static createWin(
    props: CreateExternalTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(props, WagerTransactionKind.Win);
  }

  public static createLoss(
    props: CreateExternalTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(props, WagerTransactionKind.Loss);
  }

  public static createRefund(
    props: CreateExternalTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(props, WagerTransactionKind.Refund);
  }

  public static createRollback(
    props: CreateExternalTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(
      props,
      WagerTransactionKind.Rollback,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.referenceExternalTransactionId,
      state.referenceTransactionId,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt === undefined
        ? undefined
        : new Date(state.nextReferenceAttemptAt.getTime()),
      state.referenceExpiresAt === undefined
        ? undefined
        : new Date(state.referenceExpiresAt.getTime()),
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

  public get referenceTransactionId(): string | undefined {
    return this.currentReferenceTransactionId;
  }

  public get referenceAttempts(): number {
    return this.currentReferenceAttempts;
  }

  public get nextReferenceAttemptAt(): Date | undefined {
    return this.currentNextReferenceAttemptAt === undefined
      ? undefined
      : new Date(this.currentNextReferenceAttemptAt.getTime());
  }

  public get referenceExpiresAt(): Date | undefined {
    return this.currentReferenceExpiresAt === undefined
      ? undefined
      : new Date(this.currentReferenceExpiresAt.getTime());
  }

  public get createdAt(): Date {
    return new Date(this.creationDate.getTime());
  }

  public get processedAt(): Date | undefined {
    return this.processingDate === undefined
      ? undefined
      : new Date(this.processingDate.getTime());
  }

  public markProcessed(
    balanceAfter: Money,
    at: Date,
    referenceTransactionId?: string,
  ): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balanceAfter);
    this.currentStatus = WagerTransactionStatus.Processed;
    this.currentResultBalance = balanceAfter;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.clearReferenceSchedule();
    this.processingDate = new Date(at.getTime());
  }

  public reject(
    code: WagerFailureCode,
    balance: Money,
    referenceTransactionId?: string,
  ): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balance);
    this.currentStatus = WagerTransactionStatus.Rejected;
    this.currentFailureCode = code;
    this.currentResultBalance = balance;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.clearReferenceSchedule();
  }

  public fail(balance: Money): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balance);
    this.currentStatus = WagerTransactionStatus.Failed;
    this.currentFailureCode = WagerFailureCode.ProcessingAttemptsExhausted;
    this.currentResultBalance = balance;
    this.clearReferenceSchedule();
  }

  public markPendingReference(
    balance: Money,
    nextAttemptAt: Date,
    expiresAt: Date,
  ): void {
    this.assertNotTerminal();
    this.assertResultCurrency(balance);

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'somente uma transação com referência externa pode aguardá-la',
      );
    }

    this.currentStatus = WagerTransactionStatus.PendingReference;
    this.currentResultBalance = balance;
    this.currentReferenceAttempts = 0;
    this.currentNextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
    this.currentReferenceExpiresAt = new Date(expiresAt.getTime());
  }

  public isReferenceDue(at: Date): boolean {
    return (
      this.currentStatus === WagerTransactionStatus.PendingReference &&
      this.currentNextReferenceAttemptAt !== undefined &&
      this.currentNextReferenceAttemptAt.getTime() <= at.getTime()
    );
  }

  public hasReferenceRetryExpired(at: Date, maximumAttempts: number): boolean {
    return (
      this.currentStatus === WagerTransactionStatus.PendingReference &&
      (this.currentReferenceAttempts >= maximumAttempts ||
        (this.currentReferenceExpiresAt !== undefined &&
          this.currentReferenceExpiresAt.getTime() <= at.getTime()))
    );
  }

  public scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this.currentStatus !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError();
    }

    this.currentReferenceAttempts += 1;
    this.currentNextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
  }

  public referenceFailureFor(
    reference: WagerTransaction,
  ): WagerFailureCode | undefined {
    if (this.referenceExternalTransactionId === undefined) {
      return undefined;
    }

    if (
      this.providerId !== reference.providerId ||
      this.referenceExternalTransactionId !== reference.externalTransactionId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.money.currency !== reference.money.currency ||
      this.roundId !== reference.roundId
    ) {
      return WagerFailureCode.ReferenceScopeMismatch;
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return WagerFailureCode.ReferenceNotProcessed;
    }

    const allowedKinds =
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];

    if (!allowedKinds.includes(reference.kind)) {
      return WagerFailureCode.InvalidReferenceKind;
    }

    if (
      (this.kind === WagerTransactionKind.Refund ||
        this.kind === WagerTransactionKind.Rollback) &&
      !this.money.equals(reference.money)
    ) {
      return WagerFailureCode.ReferenceAmountMismatch;
    }

    return undefined;
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

  private clearReferenceSchedule(): void {
    this.currentNextReferenceAttemptAt = undefined;
    this.currentReferenceExpiresAt = undefined;
  }

  private assertResultCurrency(balance: Money): void {
    if (this.money.currency !== balance.currency) {
      throw new InvalidWagerTransactionError(
        'o saldo resultante deve usar a moeda da transação',
      );
    }
  }

  private static createExternal(
    props: CreateExternalTransactionProps,
    kind:
      | WagerTransactionKind.Bet
      | WagerTransactionKind.Win
      | WagerTransactionKind.Loss
      | WagerTransactionKind.Refund
      | WagerTransactionKind.Rollback,
  ): WagerTransaction {
    WagerTransaction.assertRequiredExternalFields(props);

    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        `${kind} exige um valor monetário positivo`,
      );
    }

    const referenceExternalTransactionId = props.referenceExternalTransactionId;
    const hasReference = referenceExternalTransactionId !== undefined;

    if (
      (kind === WagerTransactionKind.Refund ||
        kind === WagerTransactionKind.Rollback) &&
      !hasReference
    ) {
      throw new InvalidWagerTransactionError(
        `${kind} exige referenceExternalTransactionId`,
      );
    }

    if (
      (kind === WagerTransactionKind.Bet ||
        kind === WagerTransactionKind.Loss) &&
      hasReference
    ) {
      throw new InvalidWagerTransactionError(
        `${kind} não aceita referenceExternalTransactionId`,
      );
    }

    if (
      hasReference &&
      (referenceExternalTransactionId.trim().length === 0 ||
        referenceExternalTransactionId.length > 150)
    ) {
      throw new InvalidWagerTransactionError(
        'referenceExternalTransactionId é inválido',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.referenceExternalTransactionId,
      undefined,
      0,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      new Date(props.createdAt.getTime()),
      undefined,
    );
  }

  private static assertRequiredExternalFields(
    props: CreateExternalTransactionProps,
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
