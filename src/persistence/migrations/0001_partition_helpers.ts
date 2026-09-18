import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  // Cria as particoes mensais faltantes. Idempotente e segura sob concorrencia:
  // N instancias do app chamam isto no boot ao mesmo tempo, e o advisory lock de
  // transacao serializa sem que nenhuma precise saber das outras.
  await sql`
    CREATE OR REPLACE FUNCTION gw_ensure_month_partitions(
      p_parent       text,
      p_months_back  int DEFAULT 1,
      p_months_ahead int DEFAULT 3
    ) RETURNS text[] LANGUAGE plpgsql AS $fn$
    DECLARE
      v_created text[] := '{}';
      v_start   date;
      v_end     date;
      v_name    text;
      i         int;
    BEGIN
      PERFORM pg_advisory_xact_lock(4242, hashtext(p_parent));

      FOR i IN -p_months_back .. p_months_ahead LOOP
        v_start := (date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date;
        v_end   := (v_start + interval '1 month')::date;
        v_name  := format('%s_p%s', p_parent, to_char(v_start, 'YYYYMM'));

        IF to_regclass(v_name) IS NULL THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L) '
            || 'WITH (fillfactor = 85, '
            || '      autovacuum_vacuum_scale_factor = 0.02, '
            || '      autovacuum_analyze_scale_factor = 0.02)',
            v_name, p_parent,
            to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(v_end,   'YYYY-MM-DD') || ' 00:00:00+00'
          );
          v_created := v_created || v_name;
        END IF;
      END LOOP;

      RETURN v_created;
    END $fn$;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION gw_drop_old_partitions(p_parent text, p_keep_months int)
    RETURNS text[] LANGUAGE plpgsql AS $fn$
    DECLARE
      v_dropped text[] := '{}';
      v_cutoff  date;
      r         record;
      v_month   date;
    BEGIN
      IF p_keep_months <= 0 THEN
        RETURN v_dropped;
      END IF;

      PERFORM pg_advisory_xact_lock(4242, hashtext(p_parent));
      v_cutoff := (date_trunc('month', (now() AT TIME ZONE 'UTC')) - make_interval(months => p_keep_months))::date;

      FOR r IN
        SELECT c.relname
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = p_parent::regclass
           AND c.relname ~ ('^' || p_parent || '_p[0-9]{6}$')
      LOOP
        v_month := to_date(right(r.relname, 6) || '01', 'YYYYMMDD');
        IF v_month < v_cutoff THEN
          EXECUTE format('DROP TABLE %I', r.relname);
          v_dropped := v_dropped || r.relname;
        END IF;
      END LOOP;

      RETURN v_dropped;
    END $fn$;
  `.execute(db);

  await sql`
    CREATE TABLE gw_partition_policy (
      table_name      text PRIMARY KEY,
      months_ahead    int  NOT NULL DEFAULT 3,
      keep_months     int  NOT NULL,
      last_ensured_at timestamptz,
      last_dropped_at timestamptz
    )
  `.execute(db);

  // Politica em banco, nao em env var: um deployment pode precisar de 24 meses
  // por exigencia de auditoria e outro de 2, e ninguem quer redeployar o
  // artefato por causa disso. A env var define o valor inicial, nao o vigente.
  await sql`
    INSERT INTO gw_partition_policy (table_name, months_ahead, keep_months) VALUES
      ('pipeline_delivery', 3, 6),
      ('pipeline_run',      3, 2)
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS gw_partition_policy`.execute(db);
  await sql`DROP FUNCTION IF EXISTS gw_drop_old_partitions(text, int)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS gw_ensure_month_partitions(text, int, int)`.execute(db);
}
