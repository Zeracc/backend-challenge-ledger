import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { NoOpAuthGuard } from '../../../../shared/presentation/http/no-op-auth.guard.js';
import { FinancialHttpExceptionFilter } from './financial-http-exception.filter.js';
import { QueryWalletUseCase } from '../../application/use-cases/query-wallet.js';
import { ReconciliationTelemetry } from '../../infrastructure/observability/reconciliation.telemetry.js';
import type {
  WalletView,
  LedgerPage,
  TransactionView,
  ReconciliationView,
} from '../../application/ports/wallet-read.repository.js';

@Controller()
@UseGuards(NoOpAuthGuard)
@UseFilters(FinancialHttpExceptionFilter)
export class WalletQueriesController {
  public constructor(
    private readonly queries: QueryWalletUseCase,
    private readonly telemetry: ReconciliationTelemetry,
  ) {}

  @Get('wallets/:walletId')
  public wallet(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.wallet(uuid(walletId));
  }

  @Get('wallets/:walletId/ledger')
  public ledger(
    @Param('walletId') walletId: string,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): Promise<LedgerPage> {
    if (
      limit !== undefined &&
      (typeof limit !== 'string' ||
        !/^[1-9][0-9]{0,2}$/.test(limit) ||
        Number(limit) > 100)
    )
      throw invalidQuery();
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' ||
        cursor.length === 0 ||
        cursor.length > 1024)
    )
      throw invalidQuery();
    return this.queries.ledger(
      uuid(walletId),
      limit === undefined ? 50 : Number(limit),
      cursor,
    );
  }

  @Get('wagering/transactions/:transactionId')
  public transaction(
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionView> {
    return this.queries.transaction({ id: uuid(transactionId) });
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public providerTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    if (
      providerId.trim().length === 0 ||
      providerId.length > 100 ||
      externalTransactionId.trim().length === 0 ||
      externalTransactionId.length > 150
    )
      throw invalidQuery();
    return this.queries.transaction({ providerId, externalTransactionId });
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  public reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlation: unknown,
  ): Promise<ReconciliationView> {
    if (
      correlation !== undefined &&
      (typeof correlation !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,100}$/.test(correlation))
    )
      throw invalidQuery();
    return this.queries.reconcile(uuid(walletId), correlation ?? randomUUID());
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  public metrics(): string {
    return this.telemetry.render();
  }
}

function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw invalidQuery();
  return value.toLowerCase();
}
function invalidQuery(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_QUERY',
    message:
      'Identificadores, cursor ou parâmetros de consulta inválidos. Limit deve estar entre 1 e 100.',
  });
}
