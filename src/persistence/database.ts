import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

export const DATABASE = Symbol('Database');
export const DATABASE_POOL = Symbol('DatabasePool');

export type Db = Kysely<Database>;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

let parsersInstalled = false;

function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;
  // int8 volta como string no driver pg (para nao perder precisao acima de 2^53).
  // Todo count() deste sistema cabe em number com folga, e receber string em
  // lugar de numero e a fonte classica de "0 + '1' = '01'" em contador.
  types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
  types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));
}

export function createPool(options: PoolOptions): Pool {
  installTypeParsers();
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 20,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Consulta que passa disto e bug, nao lentidao: sem teto, um plano ruim
    // segura conexao do pool ate o pool acabar.
    statement_timeout: options.statementTimeoutMs ?? 30_000,
  });
}

export function createDb(pool: Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
