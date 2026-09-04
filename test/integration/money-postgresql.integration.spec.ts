import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { PostgreSqlConnection } from '@mikro-orm/postgresql';

import { Money } from '../../src/modules/wallet/domain/value-objects/money.js';

interface NumericColumnMetadata {
  dataType: string;
  numericPrecision: number;
  numericScale: number;
}

interface PersistedMoneyRow {
  amount: string;
  currency: string;
}

const schemaName = `money_test_${randomUUID().replaceAll('-', '')}`;

describe('Money PostgreSQL round trip', () => {
  let orm: MikroORM | undefined;

  beforeAll(async () => {
    orm = await MikroORM.init({
      dbName: process.env.POSTGRES_DB ?? 'wagering',
      discovery: { warnWhenNoEntities: false },
      entities: [],
      host: process.env.POSTGRES_HOST ?? '127.0.0.1',
      password: process.env.POSTGRES_PASSWORD ?? 'wagering',
      port: parsePostgresPort(process.env.POSTGRES_PORT ?? '55432'),
      user: process.env.POSTGRES_USER ?? 'wagering',
    });

    const connection = orm.em.getConnection();

    await connection.execute(`create schema "${schemaName}"`);
    await connection.execute(`
      create table "${schemaName}"."money_round_trip" (
        "id" uuid primary key,
        "amount" numeric(20, 2) not null,
        "currency" char(3) not null
      )
    `);
  });

  afterAll(async () => {
    if (orm === undefined) {
      return;
    }

    await orm.em
      .getConnection()
      .execute(`drop schema if exists "${schemaName}" cascade`);
    await orm.close(true);
  });

  it('usa uma coluna NUMERIC(20, 2)', async () => {
    const connection = getConnection(orm);
    const rows = await connection.execute<NumericColumnMetadata[]>(
      `
        select
          data_type as "dataType",
          numeric_precision as "numericPrecision",
          numeric_scale as "numericScale"
        from information_schema.columns
        where table_schema = ? and table_name = 'money_round_trip' and column_name = 'amount'
      `,
      [schemaName],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      dataType: 'numeric',
      numericPrecision: 20,
      numericScale: 2,
    });
  });

  it.each(['0.10', '999999999999999999.99'])(
    'preserva exatamente %s sem conversão para number',
    async (amount) => {
      const connection = getConnection(orm);
      const original = Money.from({ amount, currency: 'BRL' });
      const persisted = original.toJSON();
      const id = randomUUID();

      await connection.execute(
        `insert into "${schemaName}"."money_round_trip" ("id", "amount", "currency") values (?, ?, ?)`,
        [id, persisted.amount, persisted.currency],
      );

      const rows = await connection.execute<PersistedMoneyRow[]>(
        `select "amount", "currency" from "${schemaName}"."money_round_trip" where "id" = ?`,
        [id],
      );
      const row = rows[0];

      expect(row).toBeDefined();
      expect(typeof row?.amount).toBe('string');

      const rehydrated = Money.from({
        amount: row?.amount ?? '',
        currency: row?.currency ?? '',
      });

      expect(rehydrated.equals(original)).toBe(true);
      expect(rehydrated.toJSON()).toEqual(persisted);
    },
  );
});

function parsePostgresPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('POSTGRES_PORT deve ser um número inteiro positivo.');
  }

  return Number.parseInt(value, 10);
}

function getConnection(orm: MikroORM | undefined): PostgreSqlConnection {
  if (orm === undefined) {
    throw new Error(
      'A conexão de teste com o PostgreSQL não foi inicializada.',
    );
  }

  return orm.em.getConnection();
}
