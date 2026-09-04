import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/modules/wallet/application/use-cases/open-wallet.js';
import { MikroOrmWalletOpeningRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import { WalletController } from '../../src/modules/wallet/presentation/http/wallet.controller.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { createWalletTestOrm } from './support/wallet-test-orm.js';

const schemaName = `wallet_http_test_${randomUUID().replaceAll('-', '')}`;
let app: INestApplication | undefined;
let orm: MikroORM | undefined;

describe('POST /wallets', () => {
  beforeAll(async () => {
    orm = await createWalletTestOrm(schemaName, true);
    const useCase = new OpenWalletUseCase(
      new MikroOrmWalletOpeningRepository(orm.em.fork()),
      new UuidGenerator(),
      new SystemClock(),
    );
    const testingModule = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: OpenWalletUseCase, useValue: useCase }],
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

  it('cria uma wallet e devolve o contrato obrigatório', async () => {
    const playerId = randomUUID();
    const response = await postWallet({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const payload: unknown = await response.json();

    if (!isObject(payload)) {
      throw new Error('A resposta de criação da wallet não é um objeto JSON.');
    }

    expect(typeof payload.id).toBe('string');
    expect(payload).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('retorna conflito ao repetir player e moeda', async () => {
    const playerId = randomUUID();
    const body = {
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    };

    expect((await postWallet(body)).status).toBe(201);

    const duplicate = await postWallet(body);

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      code: 'WALLET_ALREADY_EXISTS',
      message: 'Já existe uma wallet para este player e esta moeda.',
    });
  });

  it('retorna bad request para contrato ou Money inválidos', async () => {
    const invalidPlayer = await postWallet({
      playerId: 'not-a-uuid',
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const invalidMoney = await postWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '10.001', currency: 'BRL' },
    });

    expect(invalidPlayer.status).toBe(400);
    expect(invalidMoney.status).toBe(400);
  });
});

async function postWallet(body: object): Promise<Response> {
  if (app === undefined) {
    throw new Error('A aplicação HTTP de teste não foi inicializada.');
  }

  return fetch(`${await app.getUrl()}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
