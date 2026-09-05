import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { OutboxMessageRecord } from '../../../modules/wallet/infrastructure/persistence/mikro-orm/entities/outbox-message.record.js';
import { WagerTransactionRecord } from '../../../modules/wallet/infrastructure/persistence/mikro-orm/entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from '../../../modules/wallet/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.record.js';
import { WalletRecord } from '../../../modules/wallet/infrastructure/persistence/mikro-orm/entities/wallet.record.js';
import { loadPostgreSqlSettings } from './postgresql-settings.js';
import { InboxMessageRecord } from '../../../modules/wallet/infrastructure/persistence/mikro-orm/entities/inbox-message.record.js';

export const mikroOrmOptions = defineConfig({
  ...loadPostgreSqlSettings(),
  debug: false,
  forceUndefined: true,
  entities: [
    InboxMessageRecord,
    WalletRecord,
    WagerTransactionRecord,
    WalletLedgerEntryRecord,
    OutboxMessageRecord,
  ],
  extensions: [Migrator],
  metadataProvider: ReflectMetadataProvider,
  migrations: {
    allOrNothing: true,
    path: './dist/shared/infrastructure/database/migrations',
    pathTs: './src/shared/infrastructure/database/migrations',
    transactional: true,
  },
});
