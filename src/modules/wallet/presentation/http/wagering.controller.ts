import {
  parseProcessWagerTransactionInput,
  InvalidWagerRequestError,
} from '../../application/parse-wager-input.js';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';

import { NoOpAuthGuard } from '../../../../shared/presentation/http/no-op-auth.guard.js';
import { UseFilters } from '@nestjs/common';
import { FinancialHttpExceptionFilter } from './financial-http-exception.filter.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionOutput,
} from '../../application/use-cases/process-wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import {
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyAmountOutOfRangeError,
} from '../../domain/errors/money.errors.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidWagerTransactionError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../domain/errors/wallet.errors.js';

@Controller('wagering/transactions')
@UseGuards(NoOpAuthGuard)
@UseFilters(FinancialHttpExceptionFilter)
export class WageringController {
  public constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(200)
  public async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ProcessWagerTransactionOutput> {
    try {
      const input = parseProcessWagerTransactionInput(idempotencyKey, body);
      const result = await this.processWagerTransaction.execute(input);

      if (result.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException(result);
      }

      if (result.status === WagerTransactionStatus.PendingReference) {
        throw new HttpException(result, HttpStatus.ACCEPTED);
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (
        error instanceof IdempotencyConflictError ||
        error instanceof ExternalTransactionConflictError ||
        error instanceof WalletPlayerMismatchError ||
        error instanceof WalletCurrencyMismatchError
      ) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({
          code: error.code,
          message: error.message,
        });
      }

      if (
        error instanceof InvalidWagerRequestError ||
        error instanceof InvalidCurrencyError ||
        error instanceof InvalidMoneyAmountError ||
        error instanceof MoneyAmountOutOfRangeError ||
        error instanceof InvalidWagerTransactionError
      ) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  }
}
