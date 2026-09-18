import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pipeline_delivery (
      id                  uuid        NOT NULL,
      created_at          timestamptz NOT NULL,
      pipeline_id         text        NOT NULL,
      destination_id      text        NOT NULL,
      event_id            uuid        NOT NULL,
      dedupe_key          text        NOT NULL,

      status              text        NOT NULL DEFAULT 'PENDING'
        CONSTRAINT pipeline_delivery_status_ck
        CHECK (status IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED','DISCARDED')),
      attempt_count       smallint    NOT NULL DEFAULT 0,
      max_attempts        smallint    NOT NULL,
      next_attempt_at     timestamptz NOT NULL DEFAULT now(),
      enqueue_seq         smallint    NOT NULL DEFAULT 0,

      lease_token         uuid,
      lease_expires_at    timestamptz,
      worker_id           text,

      request_method      text        NOT NULL DEFAULT 'POST',
      request_url         text        NOT NULL,
      request_body        text,
      request_body_bytes  integer,
      request_body_sha256 text,

      response_status     smallint,
      response_body       text,
      response_headers    jsonb,
      error_code          text,
      error_message       text,
      discard_reason      text
        CHECK (discard_reason IN ('NON_RETRYABLE_STATUS','ATTEMPTS_EXHAUSTED',
                                  'DESTINATION_REMOVED','INVALID_PAYLOAD','MANUAL')),

      trace_id            text,
      first_attempt_at    timestamptz,
      last_attempt_at     timestamptz,
      delivered_at        timestamptz,
      duration_ms         integer,
      drain_count         smallint    NOT NULL DEFAULT 0,
      last_drained_at     timestamptz,
      updated_at          timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `.execute(db);

  await sql`
    COMMENT ON TABLE pipeline_delivery IS
      'Uma linha por (evento x destino). E a MAIOR tabela do sistema e a unica com UPDATE quente. '
      'pipeline_id e destination_id vem do YAML e NAO SAO FK; event_id tambem nao e FK, porque pipeline_event tem '
      'retencao independente e uma FK entre tabela particionada e nao particionada amarraria a ordem de purga sem '
      'ganho real -- a integridade e garantida pela transacao de fan-out. '
      'created_at DESTA linha e o created_at do EVENTO, nao now(): assim evento e entregas caem sempre na MESMA '
      'particao e a busca por dedupe_key poda identicamente nas duas tabelas.'
  `.execute(db);

  await sql`
    COMMENT ON COLUMN pipeline_delivery.enqueue_seq IS
      'Encarnacao do jobId (d:<id>:<seq>). Existe por causa de uma consequencia nao obvia de manter jobs falhados na '
      'fila: quando uma entrega esgota tentativas, o job fica no set failed COM AQUELE ID para sempre, e um add() com '
      'o mesmo id e no-op SILENCIOSO. Sem incrementar o seq, uma entrega ressuscitada por replay ou pelo drenador '
      'nunca voltaria a rodar, enquanto o log afirmaria que foi reenfileirada.'
  `.execute(db);

  await sql`
    COMMENT ON COLUMN pipeline_delivery.max_attempts IS
      'Teto DURAVEL de tentativas, copiado do YAML no fan-out. O attempts do BullMQ e um contador em Redis: perdido o '
      'Redis, o drenador recria o job e uma entrega que ja tentou 8 vezes tentaria mais 8. O Postgres decide SE ainda '
      'ha tentativa; o BullMQ decide QUANDO ela roda.'
  `.execute(db);

  await sql`CREATE TABLE pipeline_delivery_default PARTITION OF pipeline_delivery DEFAULT`.execute(
    db,
  );

  // IN_FLIGHT entra no predicado de proposito. Sem ele, uma entrega orfa
  // (instancia morta no meio da chamada HTTP) fica invisivel a qualquer consulta
  // indexada, e o reaper viraria seq scan da particao do mes. O indice continua
  // minusculo porque so guarda linhas NAO TERMINAIS -- 99,9% da tabela e
  // DELIVERED/DISCARDED e nao entra.
  await sql`
    CREATE INDEX pipeline_delivery_pending_idx
      ON pipeline_delivery (next_attempt_at)
      WHERE status IN ('PENDING','FAILED','IN_FLIGHT')
  `.execute(db);

  // Busca de suporte: "cade a nota 12345?" responde sem JOIN.
  await sql`
    CREATE INDEX pipeline_delivery_dedupe_idx ON pipeline_delivery (pipeline_id, dedupe_key)
  `.execute(db);

  await sql`
    CREATE INDEX pipeline_delivery_dest_idx
      ON pipeline_delivery (destination_id, status, created_at DESC)
  `.execute(db);

  // Cinto e suspensorio: o fan-out roda na MESMA transacao do insert do evento,
  // entao fan-out duplo e estruturalmente impossivel. Este indice existe para
  // que, se acontecer, o INSERT falhe alto em vez de entregar duas vezes.
  await sql`
    CREATE UNIQUE INDEX pipeline_delivery_event_dest_uk
      ON pipeline_delivery (event_id, destination_id, created_at)
  `.execute(db);

  await sql`SELECT gw_ensure_month_partitions('pipeline_delivery', 1, 3)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS pipeline_delivery CASCADE`.execute(db);
}
