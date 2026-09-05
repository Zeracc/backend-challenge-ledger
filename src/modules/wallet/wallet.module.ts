import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Module, type Provider } from '@nestjs/common';

import { SystemClock } from '../../shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../shared/infrastructure/serialization/sha256-payload-hasher.js';
import { NoOpAuthGuard } from '../../shared/presentation/http/no-op-auth.guard.js';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.js';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.js';
import { ReprocessPendingReferencesUseCase } from './application/use-cases/reprocess-pending-references.js';
import { MikroOrmWagerTransactionProcessor } from './infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { OutboxMessageRecord } from './infrastructure/persistence/mikro-orm/entities/outbox-message.record.js';
import { WagerTransactionRecord } from './infrastructure/persistence/mikro-orm/entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.record.js';
import { WalletRecord } from './infrastructure/persistence/mikro-orm/entities/wallet.record.js';
import { MikroOrmWalletOpeningRepository } from './infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import { PendingReferenceScheduler } from './infrastructure/scheduling/pending-reference.scheduler.js';
import { WalletController } from './presentation/http/wallet.controller.js';
import { WageringController } from './presentation/http/wagering.controller.js';
import { WalletQueriesController } from './presentation/http/wallet-queries.controller.js';
import { QueryWalletUseCase } from './application/use-cases/query-wallet.js';
import { MikroOrmWalletReadRepository } from './infrastructure/persistence/mikro-orm/wallet-read.repository.js';
import { ReconciliationTelemetry } from './infrastructure/observability/reconciliation.telemetry.js';
import { InboxMessageRecord } from './infrastructure/persistence/mikro-orm/entities/inbox-message.record.js';
import { sqsConsumerProvider } from './infrastructure/messaging/sqs-consumer.provider.js';
import { SqsConsumerRunner } from './infrastructure/messaging/sqs-consumer.runner.js';
import { outboxProviders } from './infrastructure/messaging/outbox.providers.js';
import { OutboxScheduler } from './infrastructure/scheduling/outbox.scheduler.js';
import { OperationalTelemetry } from './infrastructure/observability/operational.telemetry.js';
import { ObservedWagerProcessor } from './infrastructure/observability/observed-wager.processor.js';
import { OperationalMetricsService } from './infrastructure/observability/operational-metrics.service.js';

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
  inject: [EntityManager, OperationalTelemetry],
  useFactory: (
    entityManager: EntityManager,
    telemetry: OperationalTelemetry,
  ): ProcessWagerTransactionUseCase =>
    new ProcessWagerTransactionUseCase(
      new ObservedWagerProcessor(
        new MikroOrmWagerTransactionProcessor(entityManager),
        telemetry,
      ),
      new UuidGenerator(),
      new SystemClock(),
      new Sha256PayloadHasher(),
    ),
};

const reprocessPendingReferencesProvider: Provider = {
  provide: ReprocessPendingReferencesUseCase,
  inject: [EntityManager, OperationalTelemetry],
  useFactory: (
    entityManager: EntityManager,
    telemetry: OperationalTelemetry,
  ): ReprocessPendingReferencesUseCase =>
    new ReprocessPendingReferencesUseCase(
      new ObservedWagerProcessor(
        new MikroOrmWagerTransactionProcessor(entityManager),
        telemetry,
      ),
      new SystemClock(),
    ),
};

@Module({
  imports: [
    MikroOrmModule.forFeature([
      InboxMessageRecord,
      WalletRecord,
      WagerTransactionRecord,
      WalletLedgerEntryRecord,
      OutboxMessageRecord,
    ]),
  ],
  controllers: [WalletController, WageringController, WalletQueriesController],
  providers: [
    OperationalTelemetry,
    OperationalMetricsService,
    ...outboxProviders,
    OutboxScheduler,
    sqsConsumerProvider,
    SqsConsumerRunner,
    openWalletProvider,
    processWagerTransactionProvider,
    reprocessPendingReferencesProvider,
    PendingReferenceScheduler,
    NoOpAuthGuard,
    ReconciliationTelemetry,
    {
      provide: QueryWalletUseCase,
      inject: [EntityManager, ReconciliationTelemetry],
      useFactory: (
        em: EntityManager,
        telemetry: ReconciliationTelemetry,
      ): QueryWalletUseCase =>
        new QueryWalletUseCase(new MikroOrmWalletReadRepository(em), telemetry),
    },
  ],
})
export class WalletModule {}
