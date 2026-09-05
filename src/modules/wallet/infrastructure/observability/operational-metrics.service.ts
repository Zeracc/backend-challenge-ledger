import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { OperationalTelemetry } from './operational.telemetry.js';

@Injectable()
export class OperationalMetricsService {
  public constructor(
    private readonly em: EntityManager,
    private readonly telemetry: OperationalTelemetry,
  ) {}
  public async render(): Promise<string> {
    const counters = this.telemetry.render();
    try {
      const state = await this.em.fork().transactional(async (em) => {
        await em.execute("set local statement_timeout = '1s'");
        const schema = (
          em.schema ??
          em.config.get('schema') ??
          'public'
        ).replaceAll('"', '""');
        const rows = await em.execute<
          Array<{ pending: number; lag: number }>
        >(`select count(*)::int as pending,
          coalesce(greatest(0, extract(epoch from (clock_timestamp() - min(occurred_at)))), 0)::float8 as lag
          from "${schema}".outbox_messages where published_at is null`);
        return rows[0]!;
      });
      return (
        counters +
        '# TYPE outbox_pending_messages gauge\noutbox_pending_messages ' +
        state.pending +
        '\n# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds ' +
        state.lag +
        '\n# TYPE operational_metrics_collection_success gauge\noperational_metrics_collection_success 1\n'
      );
    } catch {
      return (
        counters +
        '# TYPE operational_metrics_collection_success gauge\noperational_metrics_collection_success 0\n'
      );
    }
  }
}
