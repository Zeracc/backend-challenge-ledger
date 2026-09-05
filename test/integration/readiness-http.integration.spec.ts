import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  PostgreSqlProbe,
  SqsProbe,
} from '../../src/modules/health/infrastructure/dependency-probes.js';
import { ReadinessController } from '../../src/modules/health/presentation/http/readiness.controller.js';
import { HealthController } from '../../src/modules/health/presentation/http/health.controller.js';
import { WagerTestContext } from './support/wager-test-context.js';

const context = new WagerTestContext(
  `ready_${randomUUID().replaceAll('-', '')}`,
);
describe('readiness com PostgreSQL e LocalStack reais', () => {
  let app: INestApplication;
  let failingApp: INestApplication;
  beforeAll(async () => {
    await context.start();
    app = await start(new SqsProbe());
    failingApp = await start(
      new SqsProbe(
        new SQSClient({
          endpoint: 'http://127.0.0.1:1',
          region: 'us-east-1',
          maxAttempts: 1,
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        }),
      ),
    );
  });
  afterAll(async () => {
    await app?.close();
    await failingApp?.close();
    await context.stop();
  });
  it('responde 200 somente com PostgreSQL e SQS alcançáveis, sem autenticação', async () => {
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { postgresql: true, sqs: true },
    });
  });
  it('responde 503 quando o SQS está inacessível e mantém liveness', async () => {
    const response = await fetch(`${await failingApp.getUrl()}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgresql: true, sqs: false },
    });
    expect(
      (await fetch(`${await failingApp.getUrl()}/health/live`)).status,
    ).toBe(200);
  });

  it('responde 503 quando o PostgreSQL falha, mesmo com SQS saudável', async () => {
    const failingPostgres = {
      check: async (): Promise<void> => {
        await context
          .getOrm()
          .em.fork()
          .transactional(async (em) => {
            await em.execute("set local statement_timeout = '1ms'");
            await em.execute('select pg_sleep(0.1)');
          });
      },
    };
    const module = await Test.createTestingModule({
      controllers: [ReadinessController],
      providers: [
        { provide: PostgreSqlProbe, useValue: failingPostgres },
        { provide: SqsProbe, useValue: new SqsProbe() },
      ],
    }).compile();
    const instance = module.createNestApplication();
    await instance.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${await instance.getUrl()}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'unavailable',
        checks: { postgresql: false, sqs: true },
      });
    } finally {
      await instance.close();
    }
  });
  async function start(sqs: SqsProbe): Promise<INestApplication> {
    const module = await Test.createTestingModule({
      controllers: [HealthController, ReadinessController],
      providers: [
        {
          provide: PostgreSqlProbe,
          useValue: new PostgreSqlProbe(context.getOrm().em),
        },
        { provide: SqsProbe, useValue: sqs },
      ],
    }).compile();
    const instance = module.createNestApplication();
    await instance.listen(0, '127.0.0.1');
    return instance;
  }
});
