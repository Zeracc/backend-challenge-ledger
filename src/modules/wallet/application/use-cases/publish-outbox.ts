import type { IdGenerator } from '../../../../shared/application/ports/id-generator.js';
import type { Clock } from '../../../../shared/application/ports/clock.js';
import type {
  IntegrationEventPublisher,
  OutboxObserver,
  OutboxRepository,
} from '../ports/outbox.repository.js';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  retried: number;
  leaseLost: number;
}
export class PublishOutboxUseCase {
  public constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: IntegrationEventPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly observer?: OutboxObserver,
    private readonly leaseMs = 30_000,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1)
      throw new Error('Lease inválido.');
  }
  public async execute(
    limit = 20,
    signal?: AbortSignal,
  ): Promise<PublishOutboxResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Lote de Outbox inválido.');
    const result: PublishOutboxResult = {
      claimed: 0,
      published: 0,
      retried: 0,
      leaseLost: 0,
    };
    while (result.claimed < limit && !signal?.aborted) {
      const claim = await this.repository.claim(
        this.ids.generate(),
        this.leaseMs,
      );
      if (claim === null) break;
      result.claimed += 1;
      try {
        await this.publisher.publish(claim.message);
      } catch {
        const delay = claim.message.scheduleRetry(this.clock.now());
        if (await this.repository.scheduleRetry(claim, delay)) {
          result.retried += 1;
          this.observer?.record('retry', claim.message);
        } else {
          result.leaseLost += 1;
          this.observer?.record('lease_lost', claim.message);
        }
        continue;
      }
      // Uma falha após SendMessage deixa o lease recuperável; nunca apaga o evento.
      if (await this.repository.markPublished(claim)) {
        claim.message.markPublished(this.clock.now());
        result.published += 1;
        this.observer?.record('published', claim.message);
      } else {
        result.leaseLost += 1;
        this.observer?.record('lease_lost', claim.message);
      }
    }
    return result;
  }
}
