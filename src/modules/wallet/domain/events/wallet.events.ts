import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../shared/domain/events/integration-event.js';
import type { MoneyProps } from '../value-objects/money.js';
import type { WagerTransactionKind } from '../entities/wager-transaction.js';
import type { LedgerDirection } from '../entities/wallet-ledger-entry.js';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly playerId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Readonly<MoneyProps>;
  readonly balanceBefore: Readonly<MoneyProps>;
  readonly balanceAfter: Readonly<MoneyProps>;
  readonly walletVersion: number;
}

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Readonly<MoneyProps>;
  readonly balanceAfter: Readonly<MoneyProps>;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = 'WalletBalanceChanged';
  public readonly version = 1;

  public constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super({
      ...props,
      data: {
        ...props.data,
        money: freezeMoney(props.data.money),
        balanceBefore: freezeMoney(props.data.balanceBefore),
        balanceAfter: freezeMoney(props.data.balanceAfter),
      },
    });
  }
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerTransactionProcessedData> {
  public readonly eventType = 'WagerTransactionProcessed';
  public readonly version = 1;

  public constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super({
      ...props,
      data: {
        ...props.data,
        money: freezeMoney(props.data.money),
        balanceAfter: freezeMoney(props.data.balanceAfter),
      },
    });
  }
}

function freezeMoney(money: Readonly<MoneyProps>): Readonly<MoneyProps> {
  return Object.freeze({ ...money });
}
