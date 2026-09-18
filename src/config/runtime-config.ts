export interface RuntimeConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly redis: { readonly host: string; readonly port: number; readonly db: number };
  readonly pipelinesDir: string;
  /** Teto que o Express aplica antes de saber qual pipeline e. */
  readonly globalMaxBodyBytes: number;
  readonly deliveryConcurrency: number;
  readonly drainIntervalSeconds: number;
  readonly drainGraceSeconds: number;
  readonly drainBatchSize: number;
  readonly drainLookbackDays: number;
  readonly retentionDeliveryMonths: number;
  readonly retentionRunMonths: number;
  readonly partitionMonthsAhead: number;
  readonly workerId: string;
  readonly nodeEnv: string;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed))
    throw new Error(`variavel ${key} deve ser numerica, recebido '${raw}'`);
  return parsed;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL e obrigatoria');
  }

  return Object.freeze({
    port: int(env, 'PORT', 3000),
    databaseUrl,
    redis: {
      host: str(env, 'REDIS_HOST', '127.0.0.1'),
      port: int(env, 'REDIS_PORT', 6379),
      db: int(env, 'REDIS_DB', 0),
    },
    pipelinesDir: str(env, 'PIPELINES_DIR', './pipelines'),
    globalMaxBodyBytes: int(env, 'GLOBAL_MAX_BODY_BYTES', 16 * 1024 * 1024),
    deliveryConcurrency: int(env, 'DELIVERY_CONCURRENCY', 8),
    drainIntervalSeconds: int(env, 'DRAIN_INTERVAL_SECONDS', 30),
    // Grace temporal: um job legitimamente `delayed` tem next_attempt_at no
    // futuro e fica invisivel ao drenador. Sem isto, o drenador brigaria com o
    // backoff da fila a cada ciclo.
    drainGraceSeconds: int(env, 'DRAIN_GRACE_SECONDS', 60),
    drainBatchSize: int(env, 'DRAIN_BATCH_SIZE', 500),
    // Recorte obrigatorio: sem ele a consulta do drenador varre TODAS as
    // particoes, e particionar por mes acaba piorando justamente o consumidor
    // cuja consulta e inerentemente cross-partition.
    drainLookbackDays: int(env, 'DRAIN_LOOKBACK_DAYS', 90),
    retentionDeliveryMonths: int(env, 'RETENTION_DELIVERY_MONTHS', 6),
    retentionRunMonths: int(env, 'RETENTION_RUN_MONTHS', 2),
    partitionMonthsAhead: int(env, 'PARTITION_MONTHS_AHEAD', 3),
    workerId: str(env, 'WORKER_ID', `${process.env.HOSTNAME ?? 'local'}:${process.pid}`),
    nodeEnv: str(env, 'NODE_ENV', 'development'),
  });
}
