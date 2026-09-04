import type { IntegrationEvent } from '../../../../shared/domain/events/integration-event.js';
import type { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/entities/wallet.js';

export interface WalletOpeningBundle {
  wallet: Wallet;
  openingTransaction?: WagerTransaction;
  ledgerEntry?: WalletLedgerEntry;
  events: ReadonlyArray<IntegrationEvent<object>>;
}

export interface WalletOpeningRepository {
  createAtomically(bundle: WalletOpeningBundle): Promise<void>;
}
