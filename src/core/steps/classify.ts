import type { HttpOutcome } from '../ports/http-client';
import type { DestinationSpec } from '../types/pipeline';
import { parseRetryAfter } from './backoff';

export type Classification =
  | { readonly kind: 'SUCCESS' }
  | { readonly kind: 'NON_RETRYABLE'; readonly why: string }
  | { readonly kind: 'RETRYABLE'; readonly why: string; readonly retryAfterMs?: number };

/** 4xx nao e retentado, exceto 408 (timeout) e 429 (rate limit). */
export function isNonRetryable4xx(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Regra do briefing em funcao pura, sem I/O, com tabela de casos em teste.
 *
 * 3xx conta como nao retentavel de proposito: o cliente HTTP envia com
 * `redirect: manual`, entao um 3xx significa URL de destino errada no YAML, e
 * retentar uma configuracao errada so adia o diagnostico.
 */
export function classify(outcome: HttpOutcome, dest: DestinationSpec, now: Date): Classification {
  if (outcome.kind === 'network') {
    return { kind: 'RETRYABLE', why: outcome.code };
  }
  const { status } = outcome;
  if (dest.successStatuses.includes(status)) return { kind: 'SUCCESS' };
  if (status >= 200 && status < 300) {
    // Sem lista explicita, todo 2xx e sucesso. COM lista, um 2xx fora dela nao
    // e sucesso -- mas tambem NAO PODE SER RETENTADO: o destino ja processou a
    // requisicao, e mandar de novo duplica do lado dele. Vira DISCARDED com o
    // status gravado, para alguem olhar o contrato.
    return dest.successStatuses.length === 0
      ? { kind: 'SUCCESS' }
      : { kind: 'NON_RETRYABLE', why: `HTTP_${status}_FORA_DE_SUCCESS_STATUSES` };
  }
  if (status >= 300 && status < 400) {
    return { kind: 'NON_RETRYABLE', why: `HTTP_${status}_REDIRECT` };
  }
  if (isNonRetryable4xx(status)) {
    return { kind: 'NON_RETRYABLE', why: `HTTP_${status}` };
  }
  const retryAfterMs = parseRetryAfter(outcome.headers['retry-after'], now);
  return retryAfterMs === undefined
    ? { kind: 'RETRYABLE', why: `HTTP_${status}` }
    : { kind: 'RETRYABLE', why: `HTTP_${status}`, retryAfterMs };
}
