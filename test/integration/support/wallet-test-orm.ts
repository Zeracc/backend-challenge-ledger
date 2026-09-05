import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

import { OutboxMessageRecord } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/entities/outbox-message.record.js';
import { WagerTransactionRecord } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.record.js';
import { WalletRecord } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/entities/wallet.record.js';
import { Migration20260904150000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260904150000.js';
import { Migration20260905120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260905120000.js';
import { Migration20260906120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260906120000.js';
import { Migration20260907120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260907120000.js';
import { Migration20260908120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260908120000.js';
import { loadPostgreSqlSettings } from '../../../src/shared/infrastructure/database/postgresql-settings.js';
import { Migration20260909120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260909120000.js';
import { Migration20260910120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260910120000.js';
import { InboxMessageRecord } from '../../../src/modules/wallet/infrastructure/persistence/mikro-orm/entities/inbox-message.record.js';
import { Migration20260911120000 } from '../../../src/shared/infrastructure/database/migrations/Migration20260911120000.js';

const entities = [
  InboxMessageRecord,
  WalletRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  OutboxMessageRecord,
];

export async function createWalletTestOrm(
  schema: string,
  migrate: boolean,
): Promise<MikroORM> {
  const orm = await MikroORM.init({
    ...loadPostgreSqlSettings(),
    entities,
    extensions: [Migrator],
    forceUndefined: true,
    metadataProvider: ReflectMetadataProvider,
    migrations: {
      allOrNothing: true,
      migrationsList: [
        Migration20260904150000,
        Migration20260905120000,
        Migration20260906120000,
        Migration20260907120000,
        Migration20260908120000,
        Migration20260909120000,
        Migration20260910120000,
        Migration20260911120000,
      ],
      schema,
      transactional: true,
    },
    schema,
  });

  if (migrate) {
    await orm.em
      .getConnection()
      .execute(`create schema if not exists "${schema}"`);
    await orm.migrator.up({ schema });
  }

  return orm;
}
