import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pipeline_event (
      id             uuid        PRIMARY KEY,
      created_at     timestamptz NOT NULL,
      pipeline_id    text        NOT NULL,
      dedupe_key     text        NOT NULL,
      dedupe_source  text,
      run_id         uuid        NOT NULL,
      run_created_at timestamptz NOT NULL,
      occurred_at    timestamptz,
      payload        jsonb       NOT NULL,
      payload_bytes  integer     NOT NULL,

      CONSTRAINT pipeline_event_dedupe_uk UNIQUE (pipeline_id, dedupe_key)
    )
  `.execute(db);

  await sql`
    COMMENT ON TABLE pipeline_event IS
      'Um evento por (pipeline_id, dedupe_key). O banco decide o que e novo, via INSERT ... ON CONFLICT DO NOTHING '
      'em lote. NAO E PARTICIONADA, e isso e deliberado: em tabela particionada o Postgres exige a chave de particao '
      'dentro de qualquer UNIQUE, e particionar por mes forcaria UNIQUE (pipeline_id, dedupe_key, created_at) -- o que '
      'deixaria o MESMO item entrar de novo no mes seguinte e ser entregue duas vezes. A unicidade aqui precisa ser '
      'GLOBAL. Se o volume exigir, a saida e HASH PARTITIONING pela propria tupla de dedupe (a chave de particao passa '
      'a SER a tupla, entao a unicidade continua global), nao RANGE por data. '
      'pipeline_id vem do YAML e NAO e FK. run_id e referencia logica, sem FK.'
  `.execute(db);

  await sql`
    COMMENT ON COLUMN pipeline_event.dedupe_key IS
      'sha256 hex do material da chave, nunca o valor bruto: o btree tem limite de 2704 bytes que uma chave composta '
      'de parceiro estoura, e este e o indice mais quente do sistema -- o tamanho precisa ser previsivel. '
      'O valor legivel fica em dedupe_source, que e o que o suporte procura.'
  `.execute(db);

  await sql`CREATE INDEX pipeline_event_created_idx ON pipeline_event (created_at)`.execute(db);
  await sql`
    CREATE INDEX pipeline_event_pipeline_created_idx ON pipeline_event (pipeline_id, created_at DESC)
  `.execute(db);
  await sql`CREATE INDEX pipeline_event_run_idx ON pipeline_event (run_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS pipeline_event`.execute(db);
}
