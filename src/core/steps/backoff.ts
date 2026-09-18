import type { RetrySpec } from '../types/pipeline';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Funcao UNICA de backoff, usada pelos dois lados: pela `backoffStrategy` do
 * BullMQ (que decide QUANDO o job roda) e para gravar `next_attempt_at` no
 * Postgres (que o drenador le). E por compartilharem esta implementacao que a
 * fila e o banco nunca divergem no tempo.
 *
 * `attempt` e 1-based: e o valor de attempt_count DEPOIS do incremento feito no
 * claim.
 */
export function computeBackoff(
  attempt: number,
  cfg: RetrySpec,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    return clamp(retryAfterMs, 0, cfg.maxDelayMs);
  }
  const exponent = cfg.backoff === 'exponential' ? Math.max(attempt - 1, 0) : 0;
  const base = clamp(cfg.initialDelayMs * cfg.factor ** exponent, 0, cfg.maxDelayMs);
  if (cfg.jitter <= 0) return Math.round(base);
  const factor = 1 - cfg.jitter + random() * 2 * cfg.jitter;
  return Math.round(clamp(base * factor, 0, cfg.maxDelayMs));
}

/** `Retry-After` vem em segundos ou como data HTTP. */
export function parseRetryAfter(header: string | undefined, now: Date): number | undefined {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
  const date = new Date(header);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(date.getTime() - now.getTime(), 0);
}
