import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Db } from '../database';
import type { Database } from '../schema';

export type Executor = Kysely<Database> | Transaction<Database>;

/** O core passa `tx` opaco; aqui ele volta a ter tipo, sem que o core saiba disso. */
export function executor(db: Db, tx?: unknown): Executor {
  return (tx as Executor | undefined) ?? db;
}

/** Limite de 65535 parametros do protocolo do Postgres. 1000 linhas e folga larga. */
export const INSERT_CHUNK = 1_000;

export function chunked<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function isMissingPartitionError(error: unknown): boolean {
  const pgError = error as { code?: string; message?: string };
  return pgError?.code === '23514' && /no partition of relation/i.test(pgError.message ?? '');
}

/**
 * Auto-cura de particao ausente.
 *
 * Se a particao do mes nao existir, o Postgres levanta 23514 e o INSERT do lote
 * INTEIRO morre -- a 600 req/min isso e perda de ingestao, nao um aviso. Ha tres
 * defesas para esta falha especifica (particao DEFAULT, cron diario e isto), e
 * sao proporcionais: e a falha que faz o gateway parar de aceitar dados.
 *
 * Cobre a janela em torno de AGORA (mes anterior ate monthsAhead), que e o
 * cenario real: o relogio virou para um mes que o cron ainda nao criou. Uma
 * linha datada de anos no futuro nao e lacuna de particao, e dado invalido -- e
 * deve falhar alto em vez de fazer o sistema criar particoes arbitrarias sob
 * comando de um payload externo.
 */
export async function withPartitionRecovery<T>(
  db: Db,
  table: string,
  monthsAhead: number,
  fn: () => Promise<T>,
  onRecover?: (table: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isMissingPartitionError(error)) throw error;
    onRecover?.(table);
    await sql`select gw_ensure_month_partitions(${table}, 1, ${monthsAhead})`.execute(db);
    return fn();
  }
}
