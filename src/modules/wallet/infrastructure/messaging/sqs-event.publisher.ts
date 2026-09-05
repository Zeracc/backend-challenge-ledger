import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { IntegrationEventPublisher } from '../../application/ports/outbox.repository.js';
import type { OutboxMessage } from '../../domain/entities/outbox-message.js';

export class SqsEventPublisher extends IntegrationEventPublisher {
  public constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }
  public override async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
  public close(): void {
    this.client.destroy();
  }
}
