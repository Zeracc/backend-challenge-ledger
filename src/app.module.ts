import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { HealthController } from './modules/health/presentation/http/health.controller.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { mikroOrmOptions } from './shared/infrastructure/database/mikro-orm-options.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmOptions), WalletModule],
  controllers: [HealthController],
})
export class AppModule {}
