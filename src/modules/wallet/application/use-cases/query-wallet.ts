import {
  QueryResourceNotFoundError,
  type ReconciliationObserver,
  type WalletReadRepository,
} from '../ports/wallet-read.repository.js';
import type {
  WalletView,
  LedgerPage,
  TransactionView,
  ReconciliationView,
} from '../ports/wallet-read.repository.js';

export class QueryWalletUseCase {
  public constructor(
    private readonly repository: WalletReadRepository,
    private readonly observer: ReconciliationObserver,
  ) {}

  public async wallet(walletId: string): Promise<WalletView> {
    const result = await this.repository.wallet(walletId);
    if (result === null)
      throw new QueryResourceNotFoundError('WALLET_NOT_FOUND');
    return result;
  }

  public async ledger(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerPage> {
    const result = await this.repository.ledger(walletId, limit, cursor);
    if (result === null)
      throw new QueryResourceNotFoundError('WALLET_NOT_FOUND');
    return result;
  }

  public async transaction(
    identity:
      { id: string } | { providerId: string; externalTransactionId: string },
  ): Promise<TransactionView> {
    const result = await this.repository.transaction(identity);
    if (result === null)
      throw new QueryResourceNotFoundError('TRANSACTION_NOT_FOUND');
    return result;
  }

  public async reconcile(
    walletId: string,
    correlationId: string,
  ): Promise<ReconciliationView> {
    const result = await this.repository.reconcile(walletId);
    if (result === null)
      throw new QueryResourceNotFoundError('WALLET_NOT_FOUND');
    this.observer.checked(result, correlationId);
    return result;
  }
}
