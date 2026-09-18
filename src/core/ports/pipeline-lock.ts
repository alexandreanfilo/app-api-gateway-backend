export const PIPELINE_LOCK = Symbol('PipelineLock');

export const SKIPPED = Symbol('lock.skipped');

/**
 * @Cron dispara em toda instancia e o app escala horizontalmente. Sem isto, N
 * replicas coletam a mesma pagina ao mesmo tempo.
 */
export interface PipelineLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | typeof SKIPPED>;
}
