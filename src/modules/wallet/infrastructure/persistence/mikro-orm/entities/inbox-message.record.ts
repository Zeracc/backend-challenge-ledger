import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { InboxMessage } from '../../../../domain/entities/inbox-message.js';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageRecord {
  @PrimaryKey({ length: 100 }) public consumerName: string;
  @PrimaryKey({ length: 200 }) public messageId: string;
  @Property({ length: 64 }) public payloadHash: string;
  @Property({ columnType: 'timestamptz(3)' }) public receivedAt: Date;
  @Property({ columnType: 'timestamptz(3)', nullable: true })
  public processedAt: Date | undefined;
  @Property({ type: 'uuid', nullable: true }) public transactionId:
    string | undefined;

  public constructor(message: InboxMessage) {
    this.consumerName = message.consumerName;
    this.messageId = message.messageId;
    this.payloadHash = message.payloadHash;
    this.receivedAt = message.receivedAt;
    this.processedAt = message.processedAt;
    this.transactionId = message.transactionId;
  }
  public toDomain(): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      ...(this.processedAt === undefined
        ? {}
        : { processedAt: this.processedAt }),
      ...(this.transactionId === undefined
        ? {}
        : { transactionId: this.transactionId }),
    });
  }
  public apply(message: InboxMessage): void {
    this.processedAt = message.processedAt;
    this.transactionId = message.transactionId;
  }
}
