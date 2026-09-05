import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.js';
import { SqsEventPublisher } from '../messaging/sqs-event.publisher.js';

@Injectable()
export class OutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private readonly logger = new Logger(OutboxScheduler.name);
  public constructor(
    private readonly publish: PublishOutboxUseCase,
    private readonly transport: SqsEventPublisher,
  ) {}
  public onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== 'true') return;
    this.timer = setInterval(() => this.trigger(), 1000);
    this.timer.unref?.();
    this.trigger();
  }
  public async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
    this.transport.close();
  }
  private trigger(): void {
    if (this.abort.signal.aborted || this.running !== undefined) return;
    this.running = this.publish
      .execute(20, this.abort.signal)
      .then(() => undefined)
      .catch(() => this.logger.error({ event: 'outbox_batch_failed' }))
      .finally(() => {
        this.running = undefined;
      });
  }
}
