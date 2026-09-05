import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { HealthController } from './modules/health/presentation/http/health.controller.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { mikroOrmOptions } from './shared/infrastructure/database/mikro-orm-options.js';
import { ReadinessController } from './modules/health/presentation/http/readiness.controller.js';
import {
  PostgreSqlProbe,
  SqsProbe,
} from './modules/health/infrastructure/dependency-probes.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmOptions), WalletModule],
  controllers: [HealthController, ReadinessController],
  providers: [PostgreSqlProbe, SqsProbe],
})
export class AppModule {}
