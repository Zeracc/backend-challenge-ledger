import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';

import { NoOpAuthGuard } from '../../../../shared/presentation/http/no-op-auth.guard.js';
import {
  OpenWalletUseCase,
  type OpenWalletInput,
  type OpenWalletOutput,
} from '../../application/use-cases/open-wallet.js';
import {
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyAmountOutOfRangeError,
} from '../../domain/errors/money.errors.js';
import {
  NegativeInitialBalanceError,
  WalletAlreadyExistsError,
} from '../../domain/errors/wallet.errors.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('wallets')
@UseGuards(NoOpAuthGuard)
export class WalletController {
  public constructor(private readonly openWallet: OpenWalletUseCase) {}

  @Post()
  @HttpCode(201)
  public async create(@Body() body: unknown): Promise<OpenWalletOutput> {
    const input = parseOpenWalletInput(body);

    try {
      return await this.openWallet.execute(input);
    } catch (error: unknown) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      if (
        error instanceof InvalidCurrencyError ||
        error instanceof InvalidMoneyAmountError ||
        error instanceof MoneyAmountOutOfRangeError ||
        error instanceof NegativeInitialBalanceError
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

function parseOpenWalletInput(body: unknown): OpenWalletInput {
  if (!isObject(body) || !isObject(body.initialBalance)) {
    throw invalidRequest();
  }

  const { playerId, initialBalance } = body;
  const { amount, currency } = initialBalance;

  if (
    typeof playerId !== 'string' ||
    !UUID_PATTERN.test(playerId) ||
    typeof amount !== 'string' ||
    typeof currency !== 'string'
  ) {
    throw invalidRequest();
  }

  return { playerId, initialBalance: { amount, currency } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_WALLET_REQUEST',
    message:
      'Informe playerId UUID e initialBalance com amount e currency em formato string.',
  });
}
