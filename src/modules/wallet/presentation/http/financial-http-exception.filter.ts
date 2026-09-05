import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import {
  InvalidLedgerCursorError,
  QueryResourceNotFoundError,
} from '../../application/ports/wallet-read.repository.js';

@Catch()
export class FinancialHttpExceptionFilter extends BaseExceptionFilter {
  public constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  public override catch(error: unknown, host: ArgumentsHost): void {
    if (error instanceof QueryResourceNotFoundError) {
      return super.catch(
        new NotFoundException({ code: error.code, message: error.message }),
        host,
      );
    }
    if (error instanceof InvalidLedgerCursorError) {
      return super.catch(
        new BadRequestException({ code: error.code, message: error.message }),
        host,
      );
    }
    if (isTransientDatabaseError(error)) {
      return super.catch(
        new ServiceUnavailableException({
          code: 'INFRASTRUCTURE_UNAVAILABLE',
          message:
            'Serviço temporariamente indisponível. Reenvie usando a mesma chave de idempotência.',
        }),
        host,
      );
    }
    super.catch(error, host);
  }
}

export function isTransientDatabaseError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  const code = candidate.code;
  return (
    (typeof code === 'string' &&
      (/^08[A-Z0-9]{3}$/.test(code) ||
        [
          '40001',
          '40P01',
          '55P03',
          '53300',
          '53400',
          '57P01',
          '57P02',
          '57P03',
          '57014',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EPIPE',
          'EAI_AGAIN',
        ].includes(code))) ||
    isTransientDatabaseError(candidate.cause, depth + 1)
  );
}
