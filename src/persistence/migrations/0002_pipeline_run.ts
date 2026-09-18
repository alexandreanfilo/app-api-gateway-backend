import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pipeline_run (
      id                  uuid        NOT NULL,
      created_at          timestamptz NOT NULL,
      pipeline_id         text        NOT NULL,
      run_group_id        uuid,
      trigger             text        NOT NULL CHECK (trigger IN ('POLL','ENDPOINT','MANUAL')),
      status              text        NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','ERROR')),

      request_url         text,
      request_page        integer,
      http_status         smallint,
      total_record_count  integer,

      source_ip           inet,
      body_bytes          integer,
      content_type        text,

      items_received      integer     NOT NULL DEFAULT 0,
      items_filtered_out  integer     NOT NULL DEFAULT 0,
      items_duplicate     integer     NOT NULL DEFAULT 0,
      items_new           integer     NOT NULL DEFAULT 0,
      deliveries_created  integer     NOT NULL DEFAULT 0,
      duration_ms         integer,
      error_code          text,
      error_message       text,
      trace_id            text,
      finished_at         timestamptz,

      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `.execute(db);

  await sql`
    COMMENT ON TABLE pipeline_run IS
      'Uma linha por unidade de entrada: no poll, uma por PAGINA consultada; no endpoint, uma por REQUISICAO recebida. '
      'pipeline_id vem do YAML montado em PIPELINES_DIR e NAO E FK PARA LUGAR NENHUM, nem deve virar: a definicao do '
      'pipeline e artefato de deploy (arquivo), nao dado de aplicacao. Nao existe tabela de pipelines neste banco. '
      'Remover um pipeline do YAML nao pode invalidar o historico ja gravado aqui. '
      'O CORPO da requisicao nao e gravado (so body_bytes): o item cru ja vive em pipeline_event, deduplicado, '
      'guardado uma vez em vez de uma vez por requisicao.'
  `.execute(db);

  // Particao de seguranca: deve ficar SEMPRE vazia. Enquanto vazia e gratuita;
  // com linhas, criar a particao do mes seguinte vira ACCESS EXCLUSIVE por
  // minutos. Por isso ha metrica e alerta em count(*) > 0.
  await sql`CREATE TABLE pipeline_run_default PARTITION OF pipeline_run DEFAULT`.execute(db);

  await sql`
    CREATE INDEX pipeline_run_pipeline_created_idx
      ON pipeline_run (pipeline_id, created_at DESC)
  `.execute(db);

  await sql`
    CREATE INDEX pipeline_run_errors_idx
      ON pipeline_run (pipeline_id, created_at DESC)
      WHERE status IN ('ERROR','PARTIAL')
  `.execute(db);

  await sql`
    CREATE INDEX pipeline_run_group_idx
      ON pipeline_run (run_group_id)
      WHERE run_group_id IS NOT NULL
  `.execute(db);

  await sql`SELECT gw_ensure_month_partitions('pipeline_run', 1, 3)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS pipeline_run CASCADE`.execute(db);
}
