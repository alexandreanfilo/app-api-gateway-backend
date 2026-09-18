import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileMigrationProvider, Migrator, NO_MIGRATIONS } from 'kysely';
import { createDb, createPool } from '../src/persistence/database';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    process.stderr.write('DATABASE_URL e obrigatoria\n');
    process.exit(1);
  }

  const pool = createPool({ connectionString });
  const db = createDb(pool);

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      // __dirname aponta para scripts/ via tsx e para dist/scripts/ compilado:
      // em ambos os casos as migrations ficam no irmao src/persistence.
      migrationFolder: path.join(__dirname, '..', 'src', 'persistence', 'migrations'),
    }),
  });

  const { error, results } =
    command === 'down'
      ? await migrator.migrateDown()
      : command === 'reset'
        ? await migrator.migrateTo(NO_MIGRATIONS)
        : await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const mark = result.status === 'Success' ? 'ok  ' : 'FALHOU';
    process.stdout.write(`${mark} ${result.migrationName}\n`);
  }

  await db.destroy();

  if (error !== undefined) {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  }
}

void main();
