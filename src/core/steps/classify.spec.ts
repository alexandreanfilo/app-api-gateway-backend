import type { HttpOutcome } from '../ports/http-client';
import { asDestinationId } from '../types/ids';
import type { DestinationSpec } from '../types/pipeline';
import { classify } from './classify';

const NOW = new Date('2026-09-17T12:00:00Z');

const destination: DestinationSpec = {
  id: asDestinationId('tsm'),
  method: 'POST',
  url: 'https://destino/eventos',
  headers: {},
  auth: { kind: 'none' },
  retry: {
    attempts: 5,
    backoff: 'exponential',
    initialDelayMs: 15_000,
    maxDelayMs: 3_600_000,
    factor: 2,
    jitter: 0.2,
  },
  timeoutMs: 30_000,
  successStatuses: [],
  persistBody: 'TRUNCATED',
  leaseSeconds: 120,
  filter: { rules: [] },
};

const response = (status: number, headers: Record<string, string> = {}): HttpOutcome => ({
  kind: 'response',
  status,
  headers,
  body: '',
  durationMs: 10,
});

describe('classify', () => {
  it.each([200, 201, 202, 204])('%d e sucesso', (status) => {
    expect(classify(response(status), destination, NOW).kind).toBe('SUCCESS');
  });

  // A regra central do briefing: 4xx nao e retentado, porque retentar uma
  // requisicao que o destino considerou invalida so gasta tentativa.
  it.each([400, 401, 403, 404, 409, 422])('%d e definitivo e nao retenta', (status) => {
    const result = classify(response(status), destination, NOW);
    expect(result.kind).toBe('NON_RETRYABLE');
  });

  // As duas excecoes: 408 e timeout do lado do servidor, 429 e "tente de novo".
  it.each([408, 429])('%d E retentavel apesar de ser 4xx', (status) => {
    expect(classify(response(status), destination, NOW).kind).toBe('RETRYABLE');
  });

  it.each([500, 502, 503, 504])('%d e retentavel', (status) => {
    expect(classify(response(status), destination, NOW).kind).toBe('RETRYABLE');
  });

  it('trata 3xx como definitivo: o cliente envia com redirect manual', () => {
    // Um redirect aqui significa URL errada no YAML. Seguir em silencio mandaria
    // o payload para um lugar que ninguem configurou -- possivelmente sem o
    // header de autenticacao.
    const result = classify(response(301, { location: 'https://outro' }), destination, NOW);
    expect(result.kind).toBe('NON_RETRYABLE');
    expect(result.kind === 'NON_RETRYABLE' && result.why).toBe('HTTP_301_REDIRECT');
  });

  it.each(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'])(
    'erro de rede %s e retentavel',
    (code) => {
      const outcome: HttpOutcome = { kind: 'network', code, message: code, durationMs: 100 };
      expect(classify(outcome, destination, NOW).kind).toBe('RETRYABLE');
    },
  );

  it('honra Retry-After em segundos', () => {
    const result = classify(response(429, { 'retry-after': '120' }), destination, NOW);
    expect(result.kind === 'RETRYABLE' && result.retryAfterMs).toBe(120_000);
  });

  it('honra Retry-After como data HTTP', () => {
    const result = classify(
      response(503, { 'retry-after': 'Thu, 17 Sep 2026 12:01:00 GMT' }),
      destination,
      NOW,
    );
    expect(result.kind === 'RETRYABLE' && result.retryAfterMs).toBe(60_000);
  });

  it('respeita successStatuses explicito do YAML', () => {
    const picky = { ...destination, successStatuses: [200, 201] };
    expect(classify(response(204), picky, NOW).kind).toBe('NON_RETRYABLE');
    expect(classify(response(201), picky, NOW).kind).toBe('SUCCESS');
  });
});
