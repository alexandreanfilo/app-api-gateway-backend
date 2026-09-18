import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { LOGGER, type Logger } from '../core/ports/logger';
import { type PipelineLock, SKIPPED } from '../core/ports/pipeline-lock';
import { alreadySafe, maskError } from '../core/redaction/mask';
import { DATABASE, type Db } from './database';

/**
 * Namespaces distintos para que o lock de coleta nunca colida com o de
 * particao (4242), com o de outra aplicacao no mesmo banco, nem com o lock
 * interno de migration do Kysely.
 */
const NS_COLLECT = 4243;

@Injectable()
export class AdvisoryLockService implements PipelineLock {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Lock de SESSAO, nao de transacao.
   *
   * `pg_try_advisory_xact_lock` libera no COMMIT, o que e elegante e errado
   * aqui: a coleta pagina HTTP contra a API do parceiro e pode durar minutos, e
   * segurar uma transacao aberta durante isso e a receita do `idle in
   * transaction` -- xmin travado, autovacuum parado no banco inteiro, e a
   * pipeline_delivery inchando.
   *
   * A conexao precisa ser FIXADA via db.connection(): sem isso o pool pode
   * mandar o unlock por outra conexao, ele retorna false em silencio, e o lock
   * vaza ate o processo morrer. Esse e o bug numero um de advisory lock com pool.
   *
   * Processo morto -> conexao cai -> Postgres libera sozinho. E exatamente a
   * semantica desejada aqui, ao contrario do claim de entrega, onde se quer um
   * estado DURAVEL que sobrevive a morte da instancia.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | typeof SKIPPED> {
    return this.db.connection().execute(async (conn) => {
      const acquired = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(${NS_COLLECT}, hashtext(${key})) AS locked
      `.execute(conn);

      if (acquired.rows[0]?.locked !== true) return SKIPPED;

      try {
        return await fn();
      } finally {
        // O unlock nunca pode mascarar a excecao original da coleta.
        await sql`SELECT pg_advisory_unlock(${NS_COLLECT}, hashtext(${key}))`
          .execute(conn)
          .catch((error: unknown) => {
            this.logger.error('advisory unlock falhou', maskError(error), alreadySafe({ key }));
          });
      }
    });
  }
}
