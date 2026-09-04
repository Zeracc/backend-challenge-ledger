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
  ProcessWagerTransactionUseCase,
  type ProcessableWagerTransactionKind,
  type ProcessWagerTransactionInput,
  type ProcessWagerTransactionOutput,
} from '../../application/use-cases/process-wager-transaction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
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
  public constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(200)
  public async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ProcessWagerTransactionOutput> {
    const input = parseProcessWagerTransactionInput(idempotencyKey, body);

    try {
      const result = await this.processWagerTransaction.execute(input);

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

function parseProcessWagerTransactionInput(
  idempotencyKey: string | undefined,
  body: unknown,
): ProcessWagerTransactionInput {
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
    referenceExternalTransactionId,
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
    !isProcessableKind(kind) ||
    referenceExternalTransactionId !== undefined ||
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
    kind,
    money: { amount, currency },
  };
}

function isProcessableKind(
  value: unknown,
): value is ProcessableWagerTransactionKind {
  return (
    value === WagerTransactionKind.Bet ||
    value === WagerTransactionKind.Win ||
    value === WagerTransactionKind.Loss
  );
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
      'Informe Idempotency-Key e um payload BET, WIN ou LOSS válido com identificadores, Money e UUIDs; referências externas ainda não são aceitas.',
  });
}
