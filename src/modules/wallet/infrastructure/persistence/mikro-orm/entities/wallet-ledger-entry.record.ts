import { DecimalType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import type { WalletLedgerEntry } from '../../../../domain/entities/wallet-ledger-entry.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'wallet_ledger_wallet_transaction_unique',
  properties: ['walletId', 'transactionId'],
})
export class WalletLedgerEntryRecord {
  @Property({ type: 'bigint', autoincrement: true })
  public sequence?: string;

  @PrimaryKey({ type: 'uuid' })
  public id: string;

  @Property({ type: 'uuid' })
  public walletId: string;

  @Property({ type: 'uuid' })
  public transactionId: string;

  @Property({ length: 6 })
  public direction: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public amount: string;

  @Property({ length: 3 })
  public currency: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public balanceBefore: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public balanceAfter: string;

  @Property({ columnType: 'timestamptz(3)' })
  public createdAt: Date;

  public constructor(entry: WalletLedgerEntry) {
    this.id = entry.id;
    this.walletId = entry.walletId;
    this.transactionId = entry.transactionId;
    this.direction = entry.direction;
    this.amount = entry.money.toString();
    this.currency = entry.money.currency;
    this.balanceBefore = entry.balanceBefore.toString();
    this.balanceAfter = entry.balanceAfter.toString();
    this.createdAt = entry.createdAt;
  }
}
