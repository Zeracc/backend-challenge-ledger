export interface PostgreSqlSettings {
  dbName: string;
  host: string;
  password: string;
  port: number;
  user: string;
}

export function loadPostgreSqlSettings(
  environment: NodeJS.ProcessEnv = process.env,
): PostgreSqlSettings {
  return {
    dbName: environment.POSTGRES_DB ?? 'wagering',
    host: environment.POSTGRES_HOST ?? '127.0.0.1',
    password: environment.POSTGRES_PASSWORD ?? 'wagering',
    port: parsePostgresPort(environment.POSTGRES_PORT ?? '55432'),
    user: environment.POSTGRES_USER ?? 'wagering',
  };
}

function parsePostgresPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('POSTGRES_PORT deve ser um número inteiro válido.');
  }

  const port = Number.parseInt(value, 10);

  if (port < 1 || port > 65_535) {
    throw new Error('POSTGRES_PORT deve estar entre 1 e 65535.');
  }

  return port;
}
