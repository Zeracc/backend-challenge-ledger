import {
  InvalidWalletIdentityError,
  NegativeInitialBalanceError,
} from '../errors/wallet.errors.js';
import type { Money } from '../value-objects/money.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private readonly currentBalance: Money,
    private readonly currentVersion: number,
    private readonly creationDate: Date,
    private readonly updateDate: Date,
  ) {}

  public static open(props: OpenWalletProps): Wallet {
    Wallet.assertIdentity(props.id, 'id');
    Wallet.assertIdentity(props.playerId, 'playerId');

    if (props.initialBalance.isNegative()) {
      throw new NegativeInitialBalanceError();
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.openedAt.getTime()),
      new Date(props.openedAt.getTime()),
    );
  }

  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  public get balance(): Money {
    return this.currentBalance;
  }

  public get version(): number {
    return this.currentVersion;
  }

  public get createdAt(): Date {
    return new Date(this.creationDate.getTime());
  }

  public get updatedAt(): Date {
    return new Date(this.updateDate.getTime());
  }

  private static assertIdentity(value: string, field: 'id' | 'playerId'): void {
    if (value.trim().length === 0) {
      throw new InvalidWalletIdentityError(field);
    }
  }
}
