import { InvalidOpeningTransactionError } from '../errors/wallet.errors.js';
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

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly kind: WagerTransactionKind,
    public readonly status: WagerTransactionStatus,
    public readonly money: Money,
    private readonly creationDate: Date,
    private readonly processingDate: Date,
  ) {}

  public static createOpening(
    props: CreateOpeningTransactionProps,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidOpeningTransactionError();
    }

    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WagerTransactionKind.Opening,
      WagerTransactionStatus.Processed,
      props.money,
      new Date(props.createdAt.getTime()),
      new Date(props.createdAt.getTime()),
    );
  }

  public get createdAt(): Date {
    return new Date(this.creationDate.getTime());
  }

  public get processedAt(): Date {
    return new Date(this.processingDate.getTime());
  }
}
