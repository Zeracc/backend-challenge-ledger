import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';

import { NoOpAuthGuard } from '../../../../shared/presentation/http/no-op-auth.guard.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
  type ProcessBetOutput,
} from '../../application/use-cases/process-bet.js';
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('wagering/transactions')
@UseGuards(NoOpAuthGuard)
export class WageringController {
  public constructor(private readonly processBet: ProcessBetUseCase) {}

  @Post()
  @HttpCode(200)
  public async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ProcessBetOutput> {
    const input = parseProcessBetInput(idempotencyKey, body);

    try {
      const result = await this.processBet.execute(input);

      if (result.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException(result);
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof UnprocessableEntityException) {
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

function parseProcessBetInput(
  idempotencyKey: string | undefined,
  body: unknown,
): ProcessBetInput {
  if (!isObject(body) || !isObject(body.money)) {
    throw invalidRequest();
  }

  const {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
  } = body;
  const { amount, currency } = money;

  if (
    !isBoundedString(idempotencyKey, 200) ||
    !isBoundedString(providerId, 100) ||
    !isBoundedString(externalTransactionId, 150) ||
    typeof playerId !== 'string' ||
    !UUID_PATTERN.test(playerId) ||
    typeof walletId !== 'string' ||
    !UUID_PATTERN.test(walletId) ||
    !isBoundedString(roundId, 150) ||
    !isBoundedString(gameId, 150) ||
    kind !== 'BET' ||
    typeof amount !== 'string' ||
    typeof currency !== 'string'
  ) {
    throw invalidRequest();
  }

  return {
    idempotencyKey,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    money: { amount, currency },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function invalidRequest(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_WAGER_REQUEST',
    message:
      'Informe Idempotency-Key e um payload BET válido com identificadores, Money e UUIDs.',
  });
}
