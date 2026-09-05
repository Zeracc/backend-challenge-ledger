import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  parseProcessWagerTransactionInput,
  InvalidWagerRequestError,
} from '../../application/parse-wager-input.js';
import type {
  ProcessWagerTransactionUseCase,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../application/use-cases/process-wager-transaction.js';
import { Sha256PayloadHasher } from '../../../../shared/infrastructure/serialization/sha256-payload-hasher.js';
import { InboxPayloadConflictError } from '../../domain/entities/inbox-message.js';
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

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  maximumAttempts: number;
  visibilitySeconds: number;
  waitSeconds: number;
  baseRetrySeconds: number;
  maximumRetrySeconds: number;
}

export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly hasher = new Sha256PayloadHasher();

  public constructor(
    private readonly client: SQSClient,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly options: SqsConsumerOptions,
  ) {
    if (
      !options.queueUrl ||
      !options.dlqUrl ||
      options.queueUrl === options.dlqUrl ||
      !options.consumerName.trim() ||
      options.consumerName.length > 100 ||
      !Number.isInteger(options.maximumAttempts) ||
      options.maximumAttempts < 1 ||
      !Number.isInteger(options.visibilitySeconds) ||
      options.visibilitySeconds < 2 ||
      options.visibilitySeconds > 43200 ||
      !Number.isInteger(options.waitSeconds) ||
      options.waitSeconds < 0 ||
      options.waitSeconds > 20 ||
      !Number.isInteger(options.baseRetrySeconds) ||
      options.baseRetrySeconds < 0 ||
      !Number.isInteger(options.maximumRetrySeconds) ||
      options.maximumRetrySeconds < options.baseRetrySeconds ||
      options.maximumRetrySeconds > 43200
    )
      throw new Error('Configuração do consumidor SQS inválida.');
  }

  public async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.options.waitSeconds,
        VisibilityTimeout: this.options.visibilitySeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    const message = response.Messages?.[0];
    if (message?.ReceiptHandle === undefined) return 0;
    if (signal?.aborted) {
      await this.visibility(message.ReceiptHandle, 0);
      return 0;
    }
    await this.handle(message);
    return 1;
  }

  public close(): void {
    this.client.destroy();
  }

  private async handle(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (receipt === undefined) return;
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(
      () => {
        if (heartbeat !== undefined) return;
        heartbeat = this.visibility(receipt, this.options.visibilitySeconds)
          .catch(() =>
            this.logger.warn({
              event: 'sqs_visibility_extension_failed',
              messageId: message.MessageId,
            }),
          )
          .finally(() => {
            heartbeat = undefined;
          });
      },
      Math.max(500, (this.options.visibilitySeconds * 1000) / 3),
    );
    let input: ProcessWagerTransactionInput | undefined;
    let logicalMessageId: string | undefined;
    let result: ProcessWagerTransactionOutput | undefined;
    let failure: unknown;
    try {
      const envelope = parseEnvelope(message.Body);
      input = envelope.input;
      logicalMessageId = envelope.messageId;
      result = await this.processWager.execute(input, {
        consumerName: this.options.consumerName,
        messageId: logicalMessageId,
        payloadHash: this.hasher.hash({
          type: 'WagerTransactionRequested',
          data: input,
        }),
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      clearInterval(timer);
      await heartbeat;
    }

    const context = {
      correlationId:
        result?.transactionId ?? logicalMessageId ?? message.MessageId,
      messageId: logicalMessageId ?? message.MessageId,
      transactionId: result?.transactionId,
      walletId: input?.walletId,
      providerId: input?.providerId,
    };
    if (result !== undefined) {
      // A execução só retorna após commit da Inbox + financeiro + Outbox.
      // Falha no delete não transforma um resultado confirmado em rejeição.
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: receipt,
        }),
      );
      this.logger.log({
        event: 'sqs_wager_acknowledged',
        ...context,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return;
    }
    const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const permanentCode = permanentFailureCode(failure);
    if (
      permanentCode !== undefined ||
      attempts >= this.options.maximumAttempts
    ) {
      const code = permanentCode ?? 'PROCESSING_ATTEMPTS_EXHAUSTED';
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? 'null',
          MessageGroupId:
            message.Attributes?.MessageGroupId ?? 'invalid-message',
          MessageDeduplicationId: createHash('sha256')
            .update(`${this.options.consumerName}:${message.MessageId}`)
            .digest('hex'),
          MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: code },
            originalMessageId: {
              DataType: 'String',
              StringValue: message.MessageId ?? 'unknown',
            },
          },
        }),
      );
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: receipt,
        }),
      );
      this.logger.warn({
        event: 'sqs_wager_dead_lettered',
        ...context,
        failureCode: code,
      });
      return;
    }
    const delay = Math.min(
      this.options.maximumRetrySeconds,
      this.options.baseRetrySeconds *
        2 ** Math.min(20, Math.max(0, attempts - 1)),
    );
    await this.visibility(receipt, delay);
    this.logger.warn({
      event: 'sqs_wager_retry_scheduled',
      ...context,
      attempts,
      delaySeconds: delay,
    });
  }

  private async visibility(receipt: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function parseEnvelope(body: string | undefined): {
  messageId: string;
  input: ProcessWagerTransactionInput;
} {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? '');
  } catch {
    throw new InvalidWagerRequestError();
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope)
  )
    throw new InvalidWagerRequestError();
  const value = envelope as Record<string, unknown>;
  if (
    value.type !== 'WagerTransactionRequested' ||
    typeof value.messageId !== 'string' ||
    value.messageId.trim().length === 0 ||
    value.messageId.length > 200 ||
    typeof value.occurredAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.occurredAt) ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    typeof value.data !== 'object' ||
    value.data === null ||
    Array.isArray(value.data)
  )
    throw new InvalidWagerRequestError();
  const data = value.data as Record<string, unknown>;
  return {
    messageId: value.messageId,
    input: parseProcessWagerTransactionInput(data.idempotencyKey, data),
  };
}

function permanentFailureCode(error: unknown): string | undefined {
  if (
    error instanceof InvalidWagerRequestError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidCurrencyError ||
    error instanceof InvalidMoneyAmountError ||
    error instanceof MoneyAmountOutOfRangeError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof WalletCurrencyMismatchError ||
    error instanceof WalletPlayerMismatchError ||
    error instanceof WalletNotFoundError
  )
    return error.code;
  return undefined;
}
