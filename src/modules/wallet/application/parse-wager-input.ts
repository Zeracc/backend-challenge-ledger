import { WagerTransactionKind } from '../domain/entities/wager-transaction.js';
import type {
  ProcessableWagerTransactionKind,
  ProcessWagerTransactionInput,
} from './use-cases/process-wager-transaction.js';
export class InvalidWagerRequestError extends Error {
  public readonly code = 'INVALID_WAGER_REQUEST';
  public constructor() {
    super(
      'Informe Idempotency-Key e um payload BET, WIN, LOSS, REFUND ou ROLLBACK válido com identificadores, Money, UUIDs e referência quando exigida.',
    );
  }
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseProcessWagerTransactionInput(
  idempotencyKey: unknown,
  body: unknown,
): ProcessWagerTransactionInput {
  if (!isObject(body) || !isObject(body.money)) {
    throw invalidRequest();
  }

  const {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
  } = body;
  const { amount, currency } = money;

  if (
    !isBoundedString(idempotencyKey, 200) ||
    !isBoundedString(providerId, 100) ||
    !isBoundedString(externalTransactionId, 150) ||
    typeof playerId !== 'string' ||
    !UUID_PATTERN.test(playerId) ||
    typeof walletId !== 'string' ||
    !UUID_PATTERN.test(walletId) ||
    !isBoundedString(roundId, 150) ||
    !isBoundedString(gameId, 150) ||
    !isProcessableKind(kind) ||
    (referenceExternalTransactionId !== undefined &&
      !isBoundedString(referenceExternalTransactionId, 150)) ||
    typeof amount !== 'string' ||
    typeof currency !== 'string'
  ) {
    throw invalidRequest();
  }

  return {
    idempotencyKey,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
    money: { amount, currency },
  };
}

function isProcessableKind(
  value: unknown,
): value is ProcessableWagerTransactionKind {
  return (
    value === WagerTransactionKind.Bet ||
    value === WagerTransactionKind.Win ||
    value === WagerTransactionKind.Loss ||
    value === WagerTransactionKind.Refund ||
    value === WagerTransactionKind.Rollback
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function invalidRequest(): InvalidWagerRequestError {
  return new InvalidWagerRequestError();
}
