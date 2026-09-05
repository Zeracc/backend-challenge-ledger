import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  SqsWagerConsumer,
  type SqsConsumerOptions,
} from '../../../src/modules/wallet/infrastructure/messaging/sqs-wager-consumer.js';
import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from '../../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { WagerTestContext } from './wager-test-context.js';

export class SqsTestContext extends WagerTestContext {
  public readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    maxAttempts: 1,
  });
  public queueUrl = '';
  public dlqUrl = '';
  public override async start(): Promise<void> {
    await super.start();
    const suffix = randomUUID();
    const dlq = await this.client.send(
      new CreateQueueCommand({
        QueueName: `test-dlq-${suffix}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    this.dlqUrl = dlq.QueueUrl!;
    const attributes = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const queue = await this.client.send(
      new CreateQueueCommand({
        QueueName: `test-wagers-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attributes.Attributes?.QueueArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    this.queueUrl = queue.QueueUrl!;
  }
  public override async stop(): Promise<void> {
    for (const queue of [this.queueUrl, this.dlqUrl])
      if (queue)
        await this.client.send(new DeleteQueueCommand({ QueueUrl: queue }));
    this.client.destroy();
    await super.stop();
  }
  public envelope(
    input: ProcessWagerTransactionInput,
    messageId = randomUUID(),
  ): string {
    return JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: input,
    });
  }
  public async send(body: string): Promise<void> {
    // Grupos diferentes propositalmente: FIFO não pode ser a garantia financeira.
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
  }
  public options(
    overrides: Partial<SqsConsumerOptions> = {},
  ): SqsConsumerOptions {
    return {
      queueUrl: this.queueUrl,
      dlqUrl: this.dlqUrl,
      consumerName: 'wager-transactions-v1',
      visibilitySeconds: 2,
      waitSeconds: 0,
      maximumAttempts: 5,
      baseRetrySeconds: 0,
      maximumRetrySeconds: 1,
      ...overrides,
    };
  }
  public consumer(
    overrides: Partial<SqsConsumerOptions> = {},
    useCase: ProcessWagerTransactionUseCase = this.createUseCase(),
  ): SqsWagerConsumer {
    return new SqsWagerConsumer(this.client, useCase, this.options(overrides));
  }
  public async deadLetter(): Promise<Message | undefined> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.dlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    const message = response.Messages?.[0];
    if (message?.ReceiptHandle)
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.dlqUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    return message;
  }
  public async inbox(
    messageId: string,
  ): Promise<
    Array<{ payloadHash: string; transactionId: string; processedAt: string }>
  > {
    return this.connection().execute(
      `select payload_hash as "payloadHash", transaction_id as "transactionId", processed_at as "processedAt" from "${this.schemaName}".inbox_messages where message_id = ?`,
      [messageId],
    );
  }
  public async failInboxCompletion(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.connection().execute(
        `create function "${this.schemaName}".fail_inbox_completion() returns trigger language plpgsql as $$ begin raise exception 'forced inbox failure' using errcode = '40001'; end; $$`,
      );
      await this.connection().execute(
        `create trigger fail_inbox_completion before update on "${this.schemaName}".inbox_messages for each row execute function "${this.schemaName}".fail_inbox_completion()`,
      );
    } else {
      await this.connection().execute(
        `drop trigger fail_inbox_completion on "${this.schemaName}".inbox_messages`,
      );
      await this.connection().execute(
        `drop function "${this.schemaName}".fail_inbox_completion()`,
      );
    }
  }
  public worker(
    crashBeforeAck = false,
  ): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
    return Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('../fixtures/sqs-process-worker.ts', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          SQS_TEST_SCHEMA: this.schemaName,
          SQS_TEST_OPTIONS: JSON.stringify(this.options({ waitSeconds: 1 })),
          SQS_TEST_CRASH: String(crashBeforeAck),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  }
}
