import { InvalidLedgerEntryError } from '../errors/wallet.errors.js';
import type { Money } from '../value-objects/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly creationDate: Date,
  ) {
    Object.freeze(this);
  }

  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('o valor deve ser positivo');
    }

    WalletLedgerEntry.assertSameCurrency(props);

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('a aritmética dos saldos não fecha');
    }

    return entry;
  }

  public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  public get createdAt(): Date {
    return new Date(this.creationDate.getTime());
  }

  public isBalanced(): boolean {
    const calculatedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return calculatedBalance.equals(this.balanceAfter);
  }

  private static assertSameCurrency(props: CreateLedgerEntryProps): void {
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError(
        'todos os valores devem usar a mesma moeda',
      );
    }
  }
}
