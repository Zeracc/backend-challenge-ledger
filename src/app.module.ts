import { Module } from '@nestjs/common';

import { HealthController } from './modules/health/presentation/http/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule {}
