import { ConsoleLogger } from '@nestjs/common';

const ERROR_EVENTS = new Set([
  'bootstrap_failed',
  'financial_http_unexpected_error',
  'pending_reference_batch_failed',
  'outbox_batch_failed',
  'sqs_consumer_poll_failed',
]);

// Framework initialization failures may contain SQL, connection URLs or secrets.
// Only application-owned event/code fields are retained at error level.
export class SafeConsoleLogger extends ConsoleLogger {
  public override error(message: unknown, ..._optionalParams: unknown[]): void {
    void _optionalParams;
    const fields =
      typeof message === 'object' &&
      message !== null &&
      !(message instanceof Error)
        ? (message as Record<string, unknown>)
        : {};
    const event = fields.event;
    const code = fields.code;
    super.error({
      event:
        typeof event === 'string' && ERROR_EVENTS.has(event)
          ? event
          : 'application_error',
      ...(code === 'INTERNAL_ERROR' ? { code } : {}),
    });
  }
}
