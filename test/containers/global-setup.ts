import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { FileMigrationProvider, Migrator } from 'kysely';
import { createDb, createPool } from '../../src/persistence/database';

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Testcontainers em vez de docker-compose de teste: o container sobe com porta
 * efemera, roda as migrations e exporta a connection string. Sem arquivo extra
 * para manter, sem conflito de porta, e identico no laptop e no CI -- enquanto
 * um compose exigiria um passo manual antes do jest, e o passo manual esquecido
 * vira "o teste esta flaky".
 */
export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('gateway_test')
    .start();

  globalThis.__PG_CONTAINER__ = container;
  process.env.DATABASE_URL = container.getConnectionUri();

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = createDb(pool);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, '..', '..', 'src', 'persistence', 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();
  await db.destroy();

  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error');
    throw new Error(
      `migrations falharam${failed ? ` em ${failed.migrationName}` : ''}: ${String(error)}`,
    );
  }
}
