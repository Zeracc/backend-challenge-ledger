import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/modules/wallet/application/use-cases/open-wallet.js';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { MikroOrmWalletOpeningRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import { WageringController } from '../../src/modules/wallet/presentation/http/wagering.controller.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { createWalletTestOrm } from './support/wallet-test-orm.js';

const schemaName = `wager_http_test_${randomUUID().replaceAll('-', '')}`;
let app: INestApplication | undefined;
let orm: MikroORM | undefined;
let openWallet: OpenWalletUseCase | undefined;

describe('POST /wagering/transactions', () => {
  beforeAll(async () => {
    orm = await createWalletTestOrm(schemaName, true);
    openWallet = new OpenWalletUseCase(
      new MikroOrmWalletOpeningRepository(orm.em.fork()),
      new UuidGenerator(),
      new SystemClock(),
    );
    const processWagerTransaction = new ProcessWagerTransactionUseCase(
      new MikroOrmWagerTransactionProcessor(orm.em.fork()),
      new UuidGenerator(),
      new SystemClock(),
      new Sha256PayloadHasher(),
    );
    const testingModule = await Test.createTestingModule({
      controllers: [WageringController],
      providers: [
        {
          provide: ProcessWagerTransactionUseCase,
          useValue: processWagerTransaction,
        },
      ],
    }).compile();

    app = testingModule.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();

    if (orm === undefined) {
      return;
    }

    await orm.migrator.down({ schema: schemaName, to: 0 });
    await orm.em
      .getConnection()
      .execute(`drop schema if exists "${schemaName}" cascade`);
    await orm.close(true);
  });

  it('processa BET e identifica o replay idempotente', async () => {
    const playerId = randomUUID();
    const wallet = await requiredOpenWallet().execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const body = betBody(wallet.id, playerId, '25.00');
    const idempotencyKey = `provider-a:${body.externalTransactionId}`;

    const first = await postTransaction(body, idempotencyKey);
    const replay = await postTransaction(body, idempotencyKey);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstPayload: unknown = await first.json();

    if (!isObject(firstPayload)) {
      throw new Error('A resposta BET não é um objeto JSON.');
    }

    expect(firstPayload).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await replay.json()).toEqual({
      ...firstPayload,
      idempotentReplay: true,
    });
  });

  it('distingue conflito de idempotência', async () => {
    const playerId = randomUUID();
    const wallet = await requiredOpenWallet().execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const body = betBody(wallet.id, playerId, '25.00');
    const idempotencyKey = `provider-a:${body.externalTransactionId}`;

    expect((await postTransaction(body, idempotencyKey)).status).toBe(200);

    const conflict = await postTransaction(
      { ...body, money: { amount: '26.00', currency: 'BRL' } },
      idempotencyKey,
    );

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('distingue rejeição por saldo insuficiente', async () => {
    const playerId = randomUUID();
    const wallet = await requiredOpenWallet().execute({
      playerId,
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });
    const body = betBody(wallet.id, playerId, '25.00');

    const response = await postTransaction(
      body,
      `provider-a:${body.externalTransactionId}`,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('processa WIN e LOSS com respostas financeiras distintas', async () => {
    const playerId = randomUUID();
    const wallet = await requiredOpenWallet().execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const winBody = wagerBody('WIN', wallet.id, playerId, '25.00');
    const lossBody = wagerBody('LOSS', wallet.id, playerId, '10.00');

    const win = await postTransaction(
      winBody,
      `provider-a:${winBody.externalTransactionId}`,
    );
    const loss = await postTransaction(
      lossBody,
      `provider-a:${lossBody.externalTransactionId}`,
    );

    expect(win.status).toBe(200);
    expect(await win.json()).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '125.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(loss.status).toBe(200);
    expect(await loss.json()).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '125.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('rejeita header ausente e impede OPENING externo', async () => {
    const invalidBody = {
      ...betBody(randomUUID(), randomUUID(), '25.00'),
      kind: 'OPENING',
    };

    expect((await postTransaction(invalidBody)).status).toBe(400);
    expect((await postTransaction(invalidBody, 'key')).status).toBe(400);
  });

  it('não ignora referência enviada antes da fase de reversões', async () => {
    const body = {
      ...wagerBody('WIN', randomUUID(), randomUUID(), '25.00'),
      referenceExternalTransactionId: 'bet-123',
    };

    expect((await postTransaction(body, 'provider-a:win-123')).status).toBe(
      400,
    );
  });
});

interface WagerHttpBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
}

function betBody(
  walletId: string,
  playerId: string,
  amount: string,
): WagerHttpBody {
  return wagerBody('BET', walletId, playerId, amount);
}

function wagerBody(
  kind: 'BET' | 'WIN' | 'LOSS',
  walletId: string,
  playerId: string,
  amount: string,
): WagerHttpBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function postTransaction(
  body: object,
  idempotencyKey?: string,
): Promise<Response> {
  if (app === undefined) {
    throw new Error('A aplicação HTTP de wagering não foi inicializada.');
  }

  return fetch(`${await app.getUrl()}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

function requiredOpenWallet(): OpenWalletUseCase {
  if (openWallet === undefined) {
    throw new Error('O caso de uso de abertura não foi inicializado.');
  }

  return openWallet;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
