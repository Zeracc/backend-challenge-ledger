import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  PostgreSqlProbe,
  SqsProbe,
} from '../../infrastructure/dependency-probes.js';

@Controller('health')
export class ReadinessController {
  public constructor(
    private readonly postgres: PostgreSqlProbe,
    private readonly sqs: SqsProbe,
  ) {}

  @Get('ready')
  public async ready(): Promise<{
    status: string;
    checks: { postgresql: boolean; sqs: boolean };
  }> {
    const [postgresql, sqs] = await Promise.all([
      probe(() => this.postgres.check()),
      probe((signal) => this.sqs.check(signal)),
    ]);
    const response = {
      status: postgresql && sqs ? 'ok' : 'unavailable',
      checks: { postgresql, sqs },
    };
    if (!postgresql || !sqs) throw new ServiceUnavailableException(response);
    return response;
  }
}

async function probe(
  check: (signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => check(abort.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('Readiness timeout'));
        }, 1500);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
