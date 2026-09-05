import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createWalletTestOrm } from '../support/wallet-test-orm.js';
import { MikroOrmOutboxRepository } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/outbox.repository.js';
import { SqsEventPublisher } from '../../../src/modules/wallet/infrastructure/messaging/sqs-event.publisher.js';
import { PublishOutboxUseCase } from '../../../src/modules/wallet/application/use-cases/publish-outbox.js';
import { UuidGenerator } from '../../../src/shared/infrastructure/system/uuid-generator.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import type { LeasedOutboxMessage } from '../../../src/modules/wallet/application/ports/outbox.repository.js';
import type { OutboxMessage } from '../../../src/modules/wallet/domain/entities/outbox-message.js';

class CrashRepository extends MikroOrmOutboxRepository {
  public override async claim(
    token: string,
    leaseMs: number,
  ): Promise<LeasedOutboxMessage | null> {
    const claim = await super.claim(token, leaseMs);
    if (claim !== null && process.env.OUTBOX_TEST_CRASH === 'after_claim') {
      console.log(`CLAIMED:${claim.message.id}`);
      process.kill(process.pid, 'SIGKILL');
    }
    return claim;
  }
}
class CrashPublisher extends SqsEventPublisher {
  public override async publish(message: OutboxMessage): Promise<void> {
    await super.publish(message);
    if (process.env.OUTBOX_TEST_CRASH === 'after_send') {
      console.log(`SENT:${message.id}`);
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
const orm = await createWalletTestOrm(process.env.OUTBOX_TEST_SCHEMA!, false);
const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  maxAttempts: 1,
});
const transport = new CrashPublisher(client, process.env.OUTBOX_TEST_QUEUE!);
const useCase = new PublishOutboxUseCase(
  new CrashRepository(orm.em.fork()),
  transport,
  new UuidGenerator(),
  new SystemClock(),
  undefined,
  process.env.OUTBOX_TEST_CRASH === 'none' ? 30_000 : 1000,
);
try {
  let published = 0;
  for (;;) {
    const result = await useCase.execute(100);
    published += result.published;
    if (result.claimed === 0) break;
  }
  console.log(JSON.stringify({ published }));
} finally {
  transport.close();
  await orm.close(true);
}
