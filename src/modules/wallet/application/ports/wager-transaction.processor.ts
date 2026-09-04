import type {
  WagerFailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import type { MoneyProps } from '../../domain/value-objects/money.js';

export interface ProcessWagerTransactionCommand {
  transaction: WagerTransaction;
  ledgerEntryId: string;
  processedEventId: string;
  rejectedEventId: string;
  balanceChangedEventId: string;
  occurredAt: Date;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: WagerFailureCode;
  idempotentReplay: boolean;
}

export interface WagerTransactionProcessor {
  processAtomically(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult>;
}
