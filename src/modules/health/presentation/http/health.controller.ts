import { Controller, Get } from '@nestjs/common';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }
}
