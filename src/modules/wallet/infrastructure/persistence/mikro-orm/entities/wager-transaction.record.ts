import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

import type { WagerTransaction } from '../../../../domain/entities/wager-transaction.js';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  public id: string;

  @Property({ length: 100, nullable: true })
  public providerId: string | undefined;

  @Property({ length: 150, nullable: true })
  public externalTransactionId: string | undefined;

  @Property({ length: 200, nullable: true })
  public idempotencyKey: string | undefined;

  @Property({ length: 64, nullable: true })
  public payloadHash: string | undefined;

  @Property({ type: 'uuid' })
  public walletId: string;

  @Property({ type: 'uuid' })
  public playerId: string;

  @Property({ length: 150, nullable: true })
  public roundId: string | undefined;

  @Property({ length: 150, nullable: true })
  public gameId: string | undefined;

  @Property({ length: 16 })
  public kind: string;

  @Property({ length: 24 })
  public status: string;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public amount: string;

  @Property({ length: 3 })
  public currency: string;

  @Property({ length: 150, nullable: true })
  public referenceExternalTransactionId: string | undefined;

  @Property({ type: 'uuid', nullable: true })
  public referenceTransactionId: string | undefined;

  @Property({ length: 50, nullable: true })
  public failureCode: string | undefined;

  @Property({ type: new DecimalType('string'), precision: 20, scale: 2 })
  public resultBalance: string;

  @Property({ length: 3 })
  public resultCurrency: string;

  @Property({ columnType: 'timestamptz(3)' })
  public createdAt: Date;

  @Property({ columnType: 'timestamptz(3)', nullable: true })
  public processedAt: Date | undefined;

  public constructor(transaction: WagerTransaction) {
    const resultBalance = transaction.resultBalance;

    if (resultBalance === undefined) {
      throw new Error(
        'Uma transação persistida precisa possuir saldo resultante.',
      );
    }

    this.id = transaction.id;
    this.providerId = transaction.providerId;
    this.externalTransactionId = transaction.externalTransactionId;
    this.idempotencyKey = transaction.idempotencyKey;
    this.payloadHash = transaction.payloadHash;
    this.walletId = transaction.walletId;
    this.playerId = transaction.playerId;
    this.roundId = transaction.roundId;
    this.gameId = transaction.gameId;
    this.kind = transaction.kind;
    this.status = transaction.status;
    this.amount = transaction.money.toString();
    this.currency = transaction.money.currency;
    this.referenceExternalTransactionId = undefined;
    this.referenceTransactionId = undefined;
    this.failureCode = transaction.failureCode;
    this.resultBalance = resultBalance.toString();
    this.resultCurrency = resultBalance.currency;
    this.createdAt = transaction.createdAt;
    this.processedAt = transaction.processedAt;
  }
}
