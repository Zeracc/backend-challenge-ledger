import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

import type { WagerTransaction } from '../../../../domain/entities/wager-transaction.js';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  public id: string;

  @Property({ type: 'uuid' })
  public walletId: string;

  @Property({ type: 'uuid' })
  public playerId: string;

  @Property({ length: 16 })
  public kind: string;

  @Property({ length: 24 })
  public status: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public amount: string;

  @Property({ length: 3 })
  public currency: string;

  @Property({ columnType: 'timestamptz(3)' })
  public createdAt: Date;

  @Property({ columnType: 'timestamptz(3)' })
  public processedAt: Date;

  public constructor(transaction: WagerTransaction) {
    this.id = transaction.id;
    this.walletId = transaction.walletId;
    this.playerId = transaction.playerId;
    this.kind = transaction.kind;
    this.status = transaction.status;
    this.amount = transaction.money.toString();
    this.currency = transaction.money.currency;
    this.createdAt = transaction.createdAt;
    this.processedAt = transaction.processedAt;
  }
}
