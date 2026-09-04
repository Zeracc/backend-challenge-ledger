import { DecimalType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { Wallet } from '../../../../domain/entities/wallet.js';
import { Money } from '../../../../domain/value-objects/money.js';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallets_player_currency_unique',
  properties: ['playerId', 'currency'],
})
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  public id!: string;

  @Property({ type: 'uuid' })
  public playerId!: string;

  @Property({ length: 3 })
  public currency!: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public balance!: string;

  @Property({ type: 'integer' })
  public version!: number;

  @Property({ columnType: 'timestamptz(3)' })
  public createdAt!: Date;

  @Property({ columnType: 'timestamptz(3)' })
  public updatedAt!: Date;

  public constructor(wallet: Wallet) {
    this.apply(wallet);
  }

  public apply(wallet: Wallet): void {
    this.id = wallet.id;
    this.playerId = wallet.playerId;
    this.currency = wallet.currency;
    this.balance = wallet.balance.toString();
    this.version = wallet.version;
    this.createdAt = wallet.createdAt;
    this.updatedAt = wallet.updatedAt;
  }

  public toDomain(): Wallet {
    return Wallet.rehydrate({
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: Money.from({ amount: this.balance, currency: this.currency }),
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }
}
