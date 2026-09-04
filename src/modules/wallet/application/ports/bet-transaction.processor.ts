import type { MoneyProps } from '../../domain/value-objects/money.js';
import type {
  WagerFailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';

export interface ProcessBetCommand {
  transaction: WagerTransaction;
  ledgerEntryId: string;
  processedEventId: string;
  rejectedEventId: string;
  balanceChangedEventId: string;
  occurredAt: Date;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: WagerFailureCode;
  idempotentReplay: boolean;
}

export interface BetTransactionProcessor {
  processAtomically(command: ProcessBetCommand): Promise<ProcessBetResult>;
}
