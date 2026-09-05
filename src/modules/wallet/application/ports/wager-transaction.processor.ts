import type {
  WagerFailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import type { MoneyProps } from '../../domain/value-objects/money.js';
import type { InboxIdentity } from '../../domain/entities/inbox-message.js';

export interface ProcessWagerTransactionCommand {
  terminalFailure?: boolean;
  inbox?: InboxIdentity;
  transaction: WagerTransaction;
  ledgerEntryId: string;
  processedEventId: string;
  rejectedEventId: string;
  balanceChangedEventId: string;
  occurredAt: Date;
  referenceExpiresAt: Date;
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

export interface ReprocessPendingReferencesCommand {
  occurredAt: Date;
  batchSize: number;
  maximumAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
}

export interface ReprocessPendingReferencesResult {
  scanned: number;
  processed: number;
  rejected: number;
  rescheduled: number;
}

export interface PendingReferenceProcessor {
  reprocessDue(
    command: ReprocessPendingReferencesCommand,
  ): Promise<ReprocessPendingReferencesResult>;
}
