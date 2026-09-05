import { Injectable, Logger } from '@nestjs/common';
import {
  ReconciliationObserver,
  type ReconciliationView,
} from '../../application/ports/wallet-read.repository.js';

@Injectable()
export class ReconciliationTelemetry extends ReconciliationObserver {
  private checks = 0;
  private mismatches = 0;
  private readonly logger = new Logger(ReconciliationTelemetry.name);

  public checked(result: ReconciliationView, correlationId: string): void {
    this.checks += 1;
    if (!result.consistent) {
      this.mismatches += 1;
      this.logger.warn({
        event: 'wallet_reconciliation_mismatch',
        correlationId,
        walletId: result.walletId,
        checkedEntries: result.checkedEntries,
      });
    }
  }

  public render(): string {
    return (
      '# HELP wallet_reconciliation_checks_total Reconciliações executadas nesta instância.\n' +
      '# TYPE wallet_reconciliation_checks_total counter\n' +
      `wallet_reconciliation_checks_total ${this.checks}\n` +
      '# HELP wallet_reconciliation_mismatches_total Divergências detectadas nesta instância.\n' +
      '# TYPE wallet_reconciliation_mismatches_total counter\n' +
      `wallet_reconciliation_mismatches_total ${this.mismatches}\n`
    );
  }
}
