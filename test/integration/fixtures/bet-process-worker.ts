import type { ProcessBetInput } from '../../../src/modules/wallet/application/use-cases/process-bet.js';
import { ProcessBetUseCase } from '../../../src/modules/wallet/application/use-cases/process-bet.js';
import { MikroOrmBetTransactionProcessor } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/bet-transaction.processor.js';
import { SystemClock } from '../../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../../src/shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { createWalletTestOrm } from '../support/wallet-test-orm.js';

async function main(): Promise<void> {
  const schema = requiredEnvironment('BET_WORKER_SCHEMA');
  const input = JSON.parse(
    requiredEnvironment('BET_WORKER_INPUT'),
  ) as ProcessBetInput;
  const attempts = Number.parseInt(
    requiredEnvironment('BET_WORKER_ATTEMPTS'),
    10,
  );
  const orm = await createWalletTestOrm(schema, false);

  try {
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        new ProcessBetUseCase(
          new MikroOrmBetTransactionProcessor(orm.em.fork()),
          new UuidGenerator(),
          new SystemClock(),
          new Sha256PayloadHasher(),
        ).execute(input),
      ),
    );

    process.stdout.write(JSON.stringify(results));
  } finally {
    await orm.close(true);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Variável ${name} não informada ao worker de teste.`);
  }

  return value;
}

await main();
