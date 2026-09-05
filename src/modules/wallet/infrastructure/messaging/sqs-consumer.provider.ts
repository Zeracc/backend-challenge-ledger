import { type Provider } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

export const sqsConsumerProvider: Provider = {
  provide: SqsWagerConsumer,
  inject: [ProcessWagerTransactionUseCase],
  useFactory: (
    processWager: ProcessWagerTransactionUseCase,
  ): SqsWagerConsumer => {
    const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
    const client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1500,
        requestTimeout: 25000,
        throwOnRequestTimeout: true,
      },
    });
    return new SqsWagerConsumer(client, processWager, {
      queueUrl:
        process.env.SQS_QUEUE_URL ??
        `${endpoint}/000000000000/wager-transactions.fifo`,
      dlqUrl:
        process.env.SQS_DLQ_URL ??
        `${endpoint}/000000000000/wager-transactions-dlq.fifo`,
      consumerName: 'wager-transactions-v1',
      maximumAttempts: 5,
      visibilitySeconds: 30,
      waitSeconds: 20,
      baseRetrySeconds: 1,
      maximumRetrySeconds: 60,
    });
  },
};
