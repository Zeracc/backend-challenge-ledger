import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsWagerConsumer,
  type SqsConsumerOptions,
} from '../../../src/modules/wallet/infrastructure/messaging/sqs-wager-consumer.js';
import { ProcessWagerTransactionUseCase } from '../../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { MikroOrmWagerTransactionProcessor } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { UuidGenerator } from '../../../src/shared/infrastructure/system/uuid-generator.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import { Sha256PayloadHasher } from '../../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { createWalletTestOrm } from '../support/wallet-test-orm.js';

Logger.overrideLogger(false);
const schema = process.env.SQS_TEST_SCHEMA!;
const options = JSON.parse(process.env.SQS_TEST_OPTIONS!) as SqsConsumerOptions;
const orm = await createWalletTestOrm(schema, false);
const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  maxAttempts: 1,
});
if (process.env.SQS_TEST_CRASH === 'true')
  client.middlewareStack.add(
    (next, context) =>
      async (args): ReturnType<typeof next> => {
        if (context.commandName === 'DeleteMessageCommand') {
          console.log('COMMITTED_BEFORE_ACK');
          process.kill(process.pid, 'SIGKILL');
        }
        return next(args);
      },
    { step: 'initialize', name: 'crashBeforeAck' },
  );
const useCase = new ProcessWagerTransactionUseCase(
  new MikroOrmWagerTransactionProcessor(orm.em.fork()),
  new UuidGenerator(),
  new SystemClock(),
  new Sha256PayloadHasher(),
);
const consumer = new SqsWagerConsumer(client, useCase, options);
let processed = 0;
let idle = 0;
const deadline = Date.now() + 20000;
try {
  while (idle < 2 && Date.now() < deadline) {
    const count = await consumer.pollOnce();
    processed += count;
    idle = count === 0 ? idle + 1 : 0;
  }
  console.log(JSON.stringify({ processed }));
} finally {
  consumer.close();
  await orm.close(true);
}
