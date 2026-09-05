import { fileURLToPath } from 'node:url';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { SqsTestContext } from './sqs-test-context.js';
import { MikroOrmOutboxRepository } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/outbox.repository.js';
import { SqsEventPublisher } from '../../../src/modules/wallet/infrastructure/messaging/sqs-event.publisher.js';
import { PublishOutboxUseCase } from '../../../src/modules/wallet/application/use-cases/publish-outbox.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../../src/shared/infrastructure/system/uuid-generator.js';

export interface OutboxRow {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
  publishedAt: Date | null;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
}
export class OutboxTestContext extends SqsTestContext {
  public repository(): MikroOrmOutboxRepository {
    return new MikroOrmOutboxRepository(this.getOrm().em.fork());
  }
  public publisher(): PublishOutboxUseCase {
    return new PublishOutboxUseCase(
      this.repository(),
      new SqsEventPublisher(this.client, this.queueUrl),
      new UuidGenerator(),
      new SystemClock(),
    );
  }
  public async outbox(): Promise<OutboxRow[]> {
    return this.connection().execute(
      `select id, payload, attempts, published_at as "publishedAt", next_attempt_at as "nextAttemptAt", lease_owner as "leaseOwner" from "${this.schemaName}".outbox_messages order by id`,
    );
  }
  public async events(): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    for (;;) {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      if (!response.Messages?.length) return events;
      for (const message of response.Messages) {
        events.push(JSON.parse(message.Body!) as Record<string, unknown>);
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  }
  public publisherWorker(
    crash: 'none' | 'after_claim' | 'after_send' = 'none',
  ): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
    return Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('../fixtures/outbox-process-worker.ts', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          OUTBOX_TEST_SCHEMA: this.schemaName,
          OUTBOX_TEST_QUEUE: this.queueUrl,
          OUTBOX_TEST_CRASH: crash,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  }
}
