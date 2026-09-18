import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DeliveryOutcomeRecord, NewDelivery } from '../src/core/ports/delivery-store';
import {
  asDedupeKey,
  asDeliveryId,
  asDestinationId,
  asEventId,
  asPipelineId,
} from '../src/core/types/ids';
import { createDb, createPool, type Db } from '../src/persistence/database';
import { PipelineDeliveryRepository } from '../src/persistence/repositories/pipeline-delivery.repository';
import { uuidV7 } from '../src/persistence/uuid';

const PIPELINE = asPipelineId('entrega');
const DESTINO = asDestinationId('destino');
const CREATED_AT = new Date('2026-09-17T12:00:00.000Z');

const OUTCOME: DeliveryOutcomeRecord = {
  responseStatus: 200,
  responseBody: '{"ok":true}',
  requestBody: '{"a":1}',
  durationMs: 12,
  persistBody: 'TRUNCATED',
};

function connect(): Db {
  return createDb(createPool({ connectionString: process.env.DATABASE_URL as string }));
}

function newDelivery(overrides: Partial<NewDelivery> = {}): NewDelivery {
  const createdAt = overrides.createdAt ?? CREATED_AT;
  return {
    id: asDeliveryId(uuidV7(createdAt)),
    createdAt,
    pipelineId: PIPELINE,
    destinationId: DESTINO,
    eventId: asEventId(uuidV7(createdAt)),
    dedupeKey: asDedupeKey(randomUUID()),
    maxAttempts: 3,
    nextAttemptAt: new Date(createdAt.getTime() - 120_000),
    requestMethod: 'POST',
    requestUrl: 'https://destino/eventos',
    ...overrides,
  };
}

describe('PipelineDeliveryRepository', () => {
  let db: Db;
  let repo: PipelineDeliveryRepository;

  beforeEach(async () => {
    db = connect();
    repo = new PipelineDeliveryRepository(db, { partitionMonthsAhead: 3 });
    await sql`TRUNCATE pipeline_delivery`.execute(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('claim atomico', () => {
    it('incrementa a tentativa ANTES do HTTP e devolve a linha', async () => {
      const row = newDelivery();
      await repo.createMany([row]);

      const claimed = await repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-1');

      // Incrementar antes do HTTP e deliberado: um payload que derruba o
      // processo consome tentativas e acaba DISCARDED, em vez de derrubar a
      // frota em laco infinito.
      expect(claimed?.attemptCount).toBe(1);
      expect(claimed?.maxAttempts).toBe(3);
    });

    it('sob concorrencia, apenas UM worker obtem o claim', async () => {
      const row = newDelivery();
      await repo.createMany([row]);

      const outraConexao = connect();
      const outro = new PipelineDeliveryRepository(outraConexao, { partitionMonthsAhead: 3 });
      try {
        const [a, b] = await Promise.all([
          repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-1'),
          outro.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-2'),
        ]);

        expect([a, b].filter((c) => c !== undefined)).toHaveLength(1);
      } finally {
        await outraConexao.destroy();
      }
    });

    it('nao reivindica quando o teto de tentativas ja foi atingido', async () => {
      const row = newDelivery({ maxAttempts: 1 });
      await repo.createMany([row]);

      const token = randomUUID();
      await repo.claim(row.id, row.createdAt, token, 120, 'worker-1');
      await repo.markFailed(row.id, row.createdAt, token, OUTCOME, 0);

      // O TETO e do Postgres, nao do contador em Redis do BullMQ: e o que
      // impede um job recriado pelo drenador de reiniciar as tentativas do zero.
      expect(
        await repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-2'),
      ).toBeUndefined();
      expect(await repo.classifyClaimMiss(row.id, row.createdAt)).toBe('ATTEMPTS_EXHAUSTED');
    });

    it('nao reivindica enquanto o lease de outro worker esta vivo', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      await repo.claim(row.id, row.createdAt, randomUUID(), 300, 'worker-1');

      expect(
        await repo.claim(row.id, row.createdAt, randomUUID(), 300, 'worker-2'),
      ).toBeUndefined();
      expect(await repo.classifyClaimMiss(row.id, row.createdAt)).toBe('LEASE_HELD_BY_OTHER');
    });

    it('ROUBA o lease quando ele expirou (instancia morta)', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      await repo.claim(row.id, row.createdAt, randomUUID(), 300, 'worker-morto');
      await sql`UPDATE pipeline_delivery SET lease_expires_at = now() - interval '1 minute'`.execute(
        db,
      );

      const roubado = await repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-2');

      // O lease com expiracao transforma "instancia morta" num estado temporario
      // e auto-resolvido; um advisory lock sumiria com a conexao e deixaria a
      // linha IN_FLIGHT para sempre, sem ninguem perceber.
      expect(roubado?.attemptCount).toBe(2);
    });
  });

  describe('fencing', () => {
    it('a escrita de resultado exige o lease vigente', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      const token = randomUUID();
      await repo.claim(row.id, row.createdAt, token, 120, 'worker-1');

      const comTokenErrado = await repo.markDelivered(row.id, row.createdAt, randomUUID(), OUTCOME);
      const comTokenCerto = await repo.markDelivered(row.id, row.createdAt, token, OUTCOME);

      // `false` significa que perdemos a posse da linha -- ou seja, acabou de
      // acontecer uma entrega duplicada. E o unico jeito de ela ser DETECTAVEL.
      expect(comTokenErrado).toBe(false);
      expect(comTokenCerto).toBe(true);
    });

    it('detecta a duplicata quando o lease e roubado durante o HTTP', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      const tokenLento = randomUUID();
      await repo.claim(row.id, row.createdAt, tokenLento, 120, 'worker-lento');

      // O worker lento trava; o lease vence; outro worker assume e entrega.
      await sql`UPDATE pipeline_delivery SET lease_expires_at = now() - interval '1 second'`.execute(
        db,
      );
      const tokenRapido = randomUUID();
      await repo.claim(row.id, row.createdAt, tokenRapido, 120, 'worker-rapido');
      await repo.markDelivered(row.id, row.createdAt, tokenRapido, OUTCOME);

      // Agora o worker lento volta do HTTP e tenta gravar o resultado dele.
      expect(await repo.markDelivered(row.id, row.createdAt, tokenLento, OUTCOME)).toBe(false);
    });
  });

  describe('maquina de estados', () => {
    it('4xx definitivo vira DISCARDED com o motivo gravado', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      const token = randomUUID();
      await repo.claim(row.id, row.createdAt, token, 120, 'w');

      await repo.markDiscarded(row.id, row.createdAt, token, 'NON_RETRYABLE_STATUS', {
        ...OUTCOME,
        responseStatus: 422,
        errorCode: 'HTTP_422',
      });

      const stored = await sql<{ status: string; discard_reason: string; response_status: number }>`
        SELECT status, discard_reason, response_status FROM pipeline_delivery WHERE id = ${row.id}::uuid
      `.execute(db);
      expect(stored.rows[0]).toMatchObject({
        status: 'DISCARDED',
        discard_reason: 'NON_RETRYABLE_STATUS',
        response_status: 422,
      });
    });

    it('markFailed agenda a proxima tentativa no futuro', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      const token = randomUUID();
      await repo.claim(row.id, row.createdAt, token, 120, 'w');

      await repo.markFailed(row.id, row.createdAt, token, OUTCOME, 60_000);

      const stored = await sql<{ status: string; next_attempt_at: Date }>`
        SELECT status, next_attempt_at FROM pipeline_delivery WHERE id = ${row.id}::uuid
      `.execute(db);
      expect(stored.rows[0]?.status).toBe('FAILED');
      expect(stored.rows[0]?.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it('trunca os corpos gravados conforme persistBody', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      const token = randomUUID();
      await repo.claim(row.id, row.createdAt, token, 120, 'w');

      await repo.markDelivered(row.id, row.createdAt, token, {
        ...OUTCOME,
        requestBody: 'x'.repeat(20_000),
        persistBody: 'TRUNCATED',
      });

      const stored = await sql<{ request_body: string; request_body_sha256: string }>`
        SELECT request_body, request_body_sha256 FROM pipeline_delivery WHERE id = ${row.id}::uuid
      `.execute(db);
      // O corpo e a maior fonte de volume da tabela; o sha256 completo continua
      // gravado para provar o que foi enviado.
      expect(stored.rows[0]?.request_body.length).toBeLessThan(9_000);
      expect(stored.rows[0]?.request_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('reaper', () => {
    it('devolve IN_FLIGHT orfao para FAILED, sem restituir a tentativa', async () => {
      const row = newDelivery();
      await repo.createMany([row]);
      await repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-morto');
      await sql`UPDATE pipeline_delivery SET lease_expires_at = now() - interval '1 minute'`.execute(
        db,
      );

      const summary = await repo.reapExpiredLeases({ lookbackDays: 30, limit: 100 });

      expect(summary.failed).toBe(1);
      const stored = await sql<{ status: string; attempt_count: number; error_code: string }>`
        SELECT status, attempt_count, error_code FROM pipeline_delivery WHERE id = ${row.id}::uuid
      `.execute(db);
      // Um crash custa uma tentativa: e o preco de nao ter laco infinito com
      // payload venenoso.
      expect(stored.rows[0]).toMatchObject({
        status: 'FAILED',
        attempt_count: 1,
        error_code: 'LEASE_EXPIRED',
      });
    });

    it('descarta o orfao que ja esgotou as tentativas', async () => {
      const row = newDelivery({ maxAttempts: 1 });
      await repo.createMany([row]);
      await repo.claim(row.id, row.createdAt, randomUUID(), 120, 'worker-morto');
      await sql`UPDATE pipeline_delivery SET lease_expires_at = now() - interval '1 minute'`.execute(
        db,
      );

      const summary = await repo.reapExpiredLeases({ lookbackDays: 30, limit: 100 });

      expect(summary.discarded).toBe(1);
    });
  });

  describe('drenador', () => {
    it('so enxerga o que ja passou do grace period', async () => {
      const vencida = newDelivery();
      const futura = newDelivery({ nextAttemptAt: new Date(Date.now() + 600_000) });
      await repo.createMany([vencida, futura]);

      const candidatos = await repo.findDrainCandidates({
        graceSeconds: 60,
        lookbackDays: 90,
        limit: 100,
      });

      // Um job legitimamente `delayed` tem next_attempt_at no futuro e fica
      // invisivel aqui: e a primeira das tres camadas contra o drenador brigar
      // com o backoff da fila.
      expect(candidatos.map((c) => c.id)).toEqual([vencida.id]);
    });

    it('incrementa enqueue_seq para ressuscitar um jobId queimado', async () => {
      const row = newDelivery();
      await repo.createMany([row]);

      expect(await repo.bumpEnqueueSeq(row.id, row.createdAt)).toBe(1);
      expect(await repo.bumpEnqueueSeq(row.id, row.createdAt)).toBe(2);
    });
  });

  describe('particionamento', () => {
    it('pipeline_delivery e particionada por RANGE em created_at', async () => {
      const result = await sql<{ strategy: string; column_name: string }>`
        SELECT p.partstrat AS strategy, a.attname AS column_name
          FROM pg_partitioned_table p
          JOIN pg_class c ON c.oid = p.partrelid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
         WHERE c.relname = 'pipeline_delivery'
      `.execute(db);

      expect(result.rows[0]).toMatchObject({ strategy: 'r', column_name: 'created_at' });
    });

    it('o indice parcial do drenador inclui IN_FLIGHT', async () => {
      const result = await sql<{ definition: string }>`
        SELECT indexdef AS definition FROM pg_indexes
         WHERE indexname = 'pipeline_delivery_pending_idx'
      `.execute(db);

      // Sem IN_FLIGHT no predicado, uma entrega orfa de instancia morta ficaria
      // invisivel a qualquer consulta indexada, e o reaper viraria seq scan da
      // particao do mes.
      const definition = result.rows[0]?.definition ?? '';
      expect(definition).toContain("'PENDING'");
      expect(definition).toContain("'FAILED'");
      expect(definition).toContain("'IN_FLIGHT'");
    });

    it('a particao DEFAULT existe e esta vazia', async () => {
      const result = await sql<{ total: number }>`
        SELECT count(*)::int AS total FROM pipeline_delivery_default
      `.execute(db);

      // Enquanto vazia e gratuita; com linhas, criar a particao do mes seguinte
      // vira ACCESS EXCLUSIVE de minutos na maior tabela do sistema.
      expect(result.rows[0]?.total).toBe(0);
    });

    it('com a particao DEFAULT presente, a linha e ACOLHIDA em vez de perdida', async () => {
      // Data alem da janela criada no boot (1 mes atras, 3 a frente).
      const longe = new Date('2028-06-15T12:00:00.000Z');
      const row = newDelivery({ createdAt: longe });

      await repo.createMany([row]);

      // A DEFAULT e uma rede de seguranca real: nenhuma linha se perde, e a
      // ingestao nao para. O preco e que o Postgres NUNCA levanta 23514
      // enquanto ela existir -- ele roteia em silencio --, entao a auto-cura de
      // particao nao dispara e quem denuncia o problema e a metrica.
      const naDefault = await sql<{ total: number }>`
        SELECT count(*)::int AS total FROM pipeline_delivery_default WHERE id = ${row.id}::uuid
      `.execute(db);
      expect(naDefault.rows[0]?.total).toBe(1);
    });

    it('sem a particao DEFAULT, a auto-cura recria o mes corrente e reexecuta o INSERT', async () => {
      // O cenario REAL desta defesa: o relogio virou para um mes cuja particao
      // ninguem criou. Simulado removendo a particao do mes corrente e a DEFAULT
      // -- sem a DEFAULT, o Postgres levanta 23514 em vez de rotear em silencio.
      const agora = new Date();
      const nomeDoMes = `pipeline_delivery_p${agora.getUTCFullYear()}${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;

      await sql`TRUNCATE pipeline_delivery`.execute(db);
      await sql`DROP TABLE pipeline_delivery_default`.execute(db);
      await sql.raw(`DROP TABLE IF EXISTS ${nomeDoMes}`).execute(db);

      try {
        const row = newDelivery({ createdAt: agora });

        await repo.createMany([row]);

        const recriada = await sql<{ relname: string }>`
          SELECT c.relname
            FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'pipeline_delivery'::regclass
             AND c.relname = ${nomeDoMes}
        `.execute(db);

        // A linha foi para a particao CERTA, criada sob demanda -- e nao para um
        // deposito que depois travaria a criacao da proxima particao.
        expect(recriada.rows).toHaveLength(1);
        const stored = await sql<{ total: number }>`
          SELECT count(*)::int AS total FROM pipeline_delivery WHERE id = ${row.id}::uuid
        `.execute(db);
        expect(stored.rows[0]?.total).toBe(1);
      } finally {
        await sql`CREATE TABLE IF NOT EXISTS pipeline_delivery_default PARTITION OF pipeline_delivery DEFAULT`.execute(
          db,
        );
      }
    });
  });
});
