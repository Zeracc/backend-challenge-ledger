import 'reflect-metadata';
import { describe, expect, it, spyOn } from 'bun:test';
import { ConsoleLogger, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SafeConsoleLogger } from './safe-console-logger.js';

describe('SafeConsoleLogger', () => {
  it('sanitiza erros e parâmetros adicionais sem perder evento e código', () => {
    const output = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const logger = new SafeConsoleLogger({ json: true });
      logger.error(new Error('SECRET_SQL amount=12.34 password=test-secret'));
      logger.error('SECRET_URL', 'SECRET_STACK', 'SECRET_CONTEXT');
      logger.error({ event: 'secret_value', code: 'SECRET_CODE' });
      logger.error({
        event: 'financial_http_unexpected_error',
        code: 'INTERNAL_ERROR',
        password: 'SECRET_PASSWORD',
      });
      const logs = JSON.stringify(output.mock.calls);
      expect(logs).not.toContain('SECRET');
      expect(logs).not.toContain('12.34');
      expect(logs).not.toContain('secret_value');
      expect(logs).toContain('financial_http_unexpected_error');
      expect(logs).toContain('INTERNAL_ERROR');
    } finally {
      output.mockRestore();
    }
  });

  it('protege a falha real de inicialização antes de o bootstrap capturar o erro', async () => {
    @Module({
      providers: [
        {
          provide: 'FAIL',
          useFactory: (): never => {
            throw new Error('BOOTSTRAP_SECRET_DATABASE_URL');
          },
        },
      ],
    })
    class BrokenModule {}
    const output = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await Promise.allSettled([
        NestFactory.create(BrokenModule, {
          logger: new SafeConsoleLogger({ json: true, logLevels: ['error'] }),
          abortOnError: false,
        }),
      ]);
      expect(result[0]?.status).toBe('rejected');
      const logs = JSON.stringify(output.mock.calls);
      expect(logs).toContain('application_error');
      expect(logs).not.toContain('BOOTSTRAP_SECRET');
    } finally {
      output.mockRestore();
      Logger.overrideLogger(new ConsoleLogger());
    }
  });
});
