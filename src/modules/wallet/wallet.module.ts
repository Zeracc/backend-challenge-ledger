import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Module, type Provider } from '@nestjs/common';

import { SystemClock } from '../../shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../shared/infrastructure/serialization/sha256-payload-hasher.js';
import { NoOpAuthGuard } from '../../shared/presentation/http/no-op-auth.guard.js';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.js';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.js';
import { MikroOrmWagerTransactionProcessor } from './infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { OutboxMessageRecord } from './infrastructure/persistence/mikro-orm/entities/outbox-message.record.js';
import { WagerTransactionRecord } from './infrastructure/persistence/mikro-orm/entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './infrastructure/persistence/mikro-orm/entities/wallet.record.js';
import { MikroOrmWalletOpeningRepository } from './infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import { WalletController } from './presentation/http/wallet.controller.js';
import { WageringController } from './presentation/http/wagering.controller.js';

const openWalletProvider: Provider = {
  provide: OpenWalletUseCase,
  inject: [EntityManager],
  useFactory: (entityManager: EntityManager): OpenWalletUseCase =>
    new OpenWalletUseCase(
      new MikroOrmWalletOpeningRepository(entityManager),
      new UuidGenerator(),
      new SystemClock(),
    ),
};

const processWagerTransactionProvider: Provider = {
  provide: ProcessWagerTransactionUseCase,
  inject: [EntityManager],
  useFactory: (entityManager: EntityManager): ProcessWagerTransactionUseCase =>
    new ProcessWagerTransactionUseCase(
      new MikroOrmWagerTransactionProcessor(entityManager),
      new UuidGenerator(),
      new SystemClock(),
      new Sha256PayloadHasher(),
    ),
};

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WalletRecord,
      WagerTransactionRecord,
      WalletLedgerEntryRecord,
      OutboxMessageRecord,
    ]),
  ],
  controllers: [WalletController, WageringController],
  providers: [
    openWalletProvider,
    processWagerTransactionProvider,
    NoOpAuthGuard,
  ],
})
export class WalletModule {}
