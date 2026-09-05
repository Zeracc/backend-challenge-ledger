import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

@Injectable()
export class SqsConsumerRunner implements OnModuleInit, OnModuleDestroy {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private readonly logger = new Logger(SqsConsumerRunner.name);
  public constructor(private readonly consumer: SqsWagerConsumer) {}
  public onModuleInit(): void {
    if (process.env.SQS_CONSUMER_ENABLED === 'true') this.running = this.run();
  }
  public async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    await this.running;
    this.consumer.close();
  }
  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.consumer.pollOnce(this.abort.signal);
      } catch {
        if (this.abort.signal.aborted) return;
        this.logger.error({ event: 'sqs_consumer_poll_failed' });
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          this.abort.signal.addEventListener('abort', finish, { once: true });
          if (this.abort.signal.aborted) finish();
        });
      }
    }
  }
}
