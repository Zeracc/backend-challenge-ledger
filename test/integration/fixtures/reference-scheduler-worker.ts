import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createWalletTestOrm } from '../support/wallet-test-orm.js';
import { PendingReferenceScheduler } from '../../../src/modules/wallet/infrastructure/scheduling/pending-reference.scheduler.js';
import { ReprocessPendingReferencesUseCase } from '../../../src/modules/wallet/application/use-cases/reprocess-pending-references.js';
import { MikroOrmWagerTransactionProcessor } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from '../../../src/modules/wallet/application/pending-reference-retry-policy.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import type { ReprocessPendingReferencesResult } from '../../../src/modules/wallet/application/ports/wager-transaction.processor.js';

Logger.overrideLogger(false);
let processed = 0;
let calls = 0;
class ObservedReprocessor extends ReprocessPendingReferencesUseCase {
  public override async execute(): Promise<ReprocessPendingReferencesResult> {
    calls++;
    const result = await super.execute();
    processed += result.processed;
    if (result.rescheduled > 0 && process.env.REFERENCE_TEST_CRASH === 'true') {
      console.log('REFERENCE_RETRY_COMMITTED');
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  }
}
const schema = process.env.REFERENCE_TEST_SCHEMA!;
const orm = await createWalletTestOrm(schema, false);
const useCase = new ObservedReprocessor(
  new MikroOrmWagerTransactionProcessor(orm.em.fork()),
  new SystemClock(),
  new PendingReferenceRetryPolicy({
    maximumAttempts: 8,
    ttlMs: 86400000,
    baseDelayMs: 10,
    maximumDelayMs: 10,
    batchSize: 100,
  }),
);
const scheduler = new PendingReferenceScheduler(useCase);
try {
  scheduler.onModuleInit();
  const deadline = Date.now() + 14000;
  for (;;) {
    await Bun.sleep(100);
    const rows = await orm.em
      .getConnection()
      .execute<Array<{ status: string }>>(
        `select status from "${schema}".wager_transactions where id = ?`,
        [process.env.REFERENCE_TEST_ID],
      );
    if (rows[0]?.status === 'PROCESSED' && calls > 0) break;
    if (Date.now() > deadline) throw new Error('Scheduler did not finish');
  }
  await scheduler.onModuleDestroy();
  console.log(JSON.stringify({ processed, calls }));
} finally {
  await scheduler.onModuleDestroy();
  await orm.close(true);
}
