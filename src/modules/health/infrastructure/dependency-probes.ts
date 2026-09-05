import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';

@Injectable()
export class PostgreSqlProbe {
  public constructor(private readonly em: EntityManager) {}
  public async check(): Promise<void> {
    await this.em.fork().execute('select 1');
  }
}

@Injectable()
export class SqsProbe implements OnModuleDestroy {
  public constructor(
    @Optional()
    private readonly client: SQSClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      maxAttempts: 1,
    }),
  ) {}
  public async check(signal: AbortSignal): Promise<void> {
    await this.client.send(new ListQueuesCommand({ MaxResults: 1 }), {
      abortSignal: signal,
    });
  }
  public onModuleDestroy(): void {
    this.client.destroy();
  }
}
