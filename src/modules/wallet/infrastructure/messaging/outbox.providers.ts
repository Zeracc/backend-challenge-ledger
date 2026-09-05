import { Logger, type Provider } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.js';
import { MikroOrmOutboxRepository } from '../persistence/mikro-orm/outbox.repository.js';
import { SqsEventPublisher } from './sqs-event.publisher.js';
import { UuidGenerator } from '../../../../shared/infrastructure/system/uuid-generator.js';
import { SystemClock } from '../../../../shared/infrastructure/system/system-clock.js';

export const outboxProviders: Provider[] = [
  {
    provide: SqsEventPublisher,
    useFactory: (): SqsEventPublisher => {
      const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
      const queue =
        process.env.SQS_EVENTS_QUEUE_URL ??
        `${endpoint}/000000000000/wager-events.fifo`;
      if (
        queue === process.env.SQS_QUEUE_URL ||
        queue.endsWith('/wager-transactions.fifo')
      )
        throw new Error(
          'Fila de eventos deve ser distinta da fila de comandos.',
        );
      return new SqsEventPublisher(
        new SQSClient({
          endpoint,
          region: process.env.AWS_REGION ?? 'us-east-1',
          maxAttempts: 1,
          requestHandler: {
            connectionTimeout: 1500,
            requestTimeout: 5000,
            throwOnRequestTimeout: true,
          },
        }),
        queue,
      );
    },
  },
  {
    provide: PublishOutboxUseCase,
    inject: [EntityManager, SqsEventPublisher],
    useFactory: (
      em: EntityManager,
      transport: SqsEventPublisher,
    ): PublishOutboxUseCase => {
      const logger = new Logger('OutboxPublisher');
      return new PublishOutboxUseCase(
        new MikroOrmOutboxRepository(em.fork()),
        transport,
        new UuidGenerator(),
        new SystemClock(),
        {
          record: (outcome, message): void => {
            const payload = message.payload;
            const data = payload.data as Record<string, unknown> | undefined;
            const context = {
              event: `outbox_${outcome}`,
              eventId: message.id,
              eventType: message.eventType,
              correlationId: payload.correlationId,
              transactionId: data?.transactionId,
              walletId: data?.walletId,
              providerId: data?.providerId,
              attempts: message.attempts,
            };
            if (outcome === 'published') logger.log(context);
            else logger.warn(context);
          },
        },
      );
    },
  },
];
