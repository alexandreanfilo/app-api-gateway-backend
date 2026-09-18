import { sql } from 'kysely';
import type { Pool } from 'pg';
import { stripNulChars } from '../src/core/steps/canonical';
import { asDedupeKey, asPipelineId, asRunId } from '../src/core/types/ids';
import type { JsonObject } from '../src/core/types/json';
import { createDb, createPool, type Db } from '../src/persistence/database';
import { PipelineEventRepository } from '../src/persistence/repositories/pipeline-event.repository';
import { UuidGenerator } from '../src/persistence/uuid';
import { eventStoreContract } from './contracts/event-store.contract';

function connect(): { pool: Pool; db: Db } {
  const pool = createPool({ connectionString: process.env.DATABASE_URL as string });
  return { pool, db: createDb(pool) };
}

function repository(db: Db): PipelineEventRepository {
  return new PipelineEventRepository(db, new UuidGenerator());
}

// Mesma suite do fake em memoria, contra Postgres de verdade. O caso de
// concorrencia so tem sentido aqui: e o indice unico que carrega a semantica,
// nao o codigo.
eventStoreContract('kysely + postgres', async () => {
  const primary = connect();
  const secondary = connect();

  await sql`TRUNCATE pipeline_event`.execute(primary.db);

  return {
    store: repository(primary.db),
    concurrent: repository(secondary.db),
    cleanup: async () => {
      await sql`TRUNCATE pipeline_event`.execute(primary.db);
      await primary.db.destroy();
      await secondary.db.destroy();
    },
  };
});

describe('PipelineEventRepository (detalhes que so o Postgres prova)', () => {
  let pool: Pool;
  let db: Db;
  let repo: PipelineEventRepository;

  beforeEach(async () => {
    ({ pool, db } = connect());
    repo = repository(db);
    await sql`TRUNCATE pipeline_event`.execute(db);
  });

  afterEach(async () => {
    await db.destroy();
    void pool;
  });

  it('a constraint unica de deduplicacao e GLOBAL, sem coluna de data', async () => {
    const constraint = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'pipeline_event_dedupe_uk'
    `.execute(db);

    // Se um dia alguem particionar pipeline_event por mes, o Postgres vai exigir
    // created_at dentro desta UNIQUE -- e o MESMO item passaria a entrar de novo
    // no mes seguinte, entregue duas vezes. Este teste e o alarme disso.
    expect(constraint.rows[0]?.definition).toBe('UNIQUE (pipeline_id, dedupe_key)');
  });

  it('pipeline_event nao e particionada', async () => {
    const result = await sql<{ relkind: string }>`
      SELECT relkind FROM pg_class WHERE relname = 'pipeline_event'
    `.execute(db);

    // 'p' seria tabela particionada; 'r' e tabela comum.
    expect(result.rows[0]?.relkind).toBe('r');
  });

  it('aceita payload com caractere NUL sem derrubar o lote inteiro', async () => {
    // Postgres REJEITA o caractere NUL dentro de jsonb. Com ON CONFLICT DO
    // NOTHING em lote, um unico byte vindo de um parceiro derrubaria os 1000
    // itens do lote, nao apenas o item ruim -- por isso a sanitizacao acontece
    // na borda, antes de chegar ao repositorio.
    //
    // Construido em runtime de proposito: um NUL literal no fonte e um byte
    // invisivel que quebra editores, diffs e ferramentas de lint.
    const NUL = String.fromCharCode(0);
    const sujo = stripNulChars({ nome: `ab${NUL}cd`, nested: { x: NUL } }) as JsonObject;

    const result = await repo.insertNewOnly([
      {
        pipelineId: asPipelineId('p'),
        dedupeKey: asDedupeKey('com-nul'),
        dedupeSource: 'field:id=com-nul',
        runId: asRunId('00000000-0000-7000-8000-000000000001'),
        runCreatedAt: new Date('2026-09-17T12:00:00Z'),
        payload: sujo,
      },
    ]);

    expect(result.inserted).toHaveLength(1);
    const eventId = result.inserted[0]?.id;
    expect(eventId).toBeDefined();
    if (eventId === undefined) return;
    expect(await repo.payloadOf(eventId)).toEqual({ nome: 'abcd', nested: { x: '' } });
  });

  it('insere lotes acima do limite de parametros do protocolo', async () => {
    // 65535 parametros e o teto do protocolo; com ~10 colunas por linha, um
    // lote de 5000 itens estouraria sem o chunking.
    const items = Array.from({ length: 2_500 }, (_, i) => ({
      pipelineId: asPipelineId('volume'),
      dedupeKey: asDedupeKey(`k-${i}`),
      dedupeSource: `field:id=${i}`,
      runId: asRunId('00000000-0000-7000-8000-000000000001'),
      runCreatedAt: new Date('2026-09-17T12:00:00Z'),
      payload: { i },
    }));

    const result = await repo.insertNewOnly(items);

    expect(result.inserted).toHaveLength(2_500);
  });
});
