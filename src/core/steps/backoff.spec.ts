import type { RetrySpec } from '../types/pipeline';
import { computeBackoff, parseRetryAfter } from './backoff';

/** retry do exemplo do GTS, com os defaults preenchidos pelo schema. */
const RETRY: RetrySpec = {
  attempts: 5,
  backoff: 'exponential',
  initialDelayMs: 15_000,
  maxDelayMs: 3_600_000,
  factor: 2,
  jitter: 0,
};

describe('computeBackoff', () => {
  it('cresce exponencialmente a partir de initialDelayMs', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => computeBackoff(attempt, RETRY));
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
  });

  it('respeita o teto de maxDelayMs', () => {
    const delay = computeBackoff(20, { ...RETRY, maxDelayMs: 60_000 });
    expect(delay).toBe(60_000);
  });

  it('com backoff fixo, o atraso nao muda entre tentativas', () => {
    const fixed = { ...RETRY, backoff: 'fixed' as const };
    expect([1, 2, 5].map((a) => computeBackoff(a, fixed))).toEqual([15_000, 15_000, 15_000]);
  });

  /**
   * Quando um destino cai, TODAS as entregas pendentes falham no mesmo segundo.
   * Sem jitter elas voltam juntas, derrubam o destino de novo e o ciclo se
   * repete em sincronia cada vez mais apertada.
   */
  it('o jitter espalha as tentativas em torno da curva', () => {
    const jittered = { ...RETRY, jitter: 0.2 };
    const delays = Array.from({ length: 50 }, () => computeBackoff(1, jittered));

    expect(new Set(delays).size).toBeGreaterThan(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(12_000);
      expect(delay).toBeLessThanOrEqual(18_000);
    }
  });

  it('Retry-After do destino tem precedencia sobre a curva', () => {
    // Quando o parceiro diz quando voltar, insistir antes so gasta tentativa.
    expect(computeBackoff(1, RETRY, 90_000)).toBe(90_000);
  });

  it('Retry-After absurdo ainda respeita o teto', () => {
    expect(computeBackoff(1, RETRY, 999_999_999)).toBe(RETRY.maxDelayMs);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('aceita segundos', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('aceita data HTTP', () => {
    expect(parseRetryAfter('Thu, 17 Sep 2026 12:02:00 GMT', now)).toBe(120_000);
  });

  it('nunca devolve valor negativo para data no passado', () => {
    expect(parseRetryAfter('Thu, 17 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('devolve undefined para header ausente ou sem sentido', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('nao-e-nada', now)).toBeUndefined();
  });
});
