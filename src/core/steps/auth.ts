import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../ports/clock';
import type { HttpClient } from '../ports/http-client';
import type { Metrics } from '../ports/metrics';
import type { SecretResolver } from '../ports/secret-resolver';
import type { TokenCache } from '../ports/token-cache';
import type { JsonValue } from '../types/json';
import type { InboundAuthSpec, OutboundAuthSpec } from '../types/pipeline';
import { exposeHeaderValue, type MaybeSecret, Secret, type SecretRef } from '../types/secret';
import { getPath } from './path';

export interface AuthPorts {
  readonly secrets: SecretResolver;
  readonly http: HttpClient;
  readonly cache: TokenCache;
  readonly clock: Clock;
  readonly metrics: Metrics;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * ESTE e o unico lugar do sistema onde um valor de credencial e materializado
 * dentro de uma string. Nao existe interpolacao de Secret em nenhum outro
 * arquivo -- se existir, `Secret.toString()` produz "[secret:NOME]" e o
 * cabecalho sai errado em silencio.
 */
function secretHeader(ref: SecretRef, prefix: string, value: string): Secret {
  return new Secret(ref.secret, prefix ? `${prefix}${value}` : value);
}

export async function buildOutboundAuthHeaders(
  spec: OutboundAuthSpec,
  pipelineId: string,
  ports: AuthPorts,
): Promise<Record<string, MaybeSecret>> {
  switch (spec.kind) {
    case 'none':
      return {};

    case 'bearer': {
      const token = await ports.secrets.resolve(spec.token.secret);
      return { authorization: secretHeader(spec.token, 'Bearer ', token.expose()) };
    }

    case 'basic': {
      const password = await ports.secrets.resolve(spec.password.secret);
      const encoded = Buffer.from(`${spec.username}:${password.expose()}`, 'utf8').toString(
        'base64',
      );
      return { authorization: secretHeader(spec.password, 'Basic ', encoded) };
    }

    case 'api-key': {
      const value = await ports.secrets.resolve(spec.value.secret);
      return { [spec.header.toLowerCase()]: secretHeader(spec.value, '', value.expose()) };
    }

    case 'login-token': {
      const token = await getLoginToken(spec, pipelineId, ports);
      const prefix = spec.scheme === 'bearer' ? 'Bearer ' : '';
      return {
        [spec.header.toLowerCase()]: new Secret(`${pipelineId}:login-token`, `${prefix}${token}`),
      };
    }
  }
}

function loginCacheKey(
  pipelineId: string,
  spec: Extract<OutboundAuthSpec, { kind: 'login-token' }>,
): string {
  return `login-token:${pipelineId}:${spec.loginUrl}`;
}

async function getLoginToken(
  spec: Extract<OutboundAuthSpec, { kind: 'login-token' }>,
  pipelineId: string,
  ports: AuthPorts,
): Promise<string> {
  const key = loginCacheKey(pipelineId, spec);
  const cached = await ports.cache.get(key);
  if (cached !== undefined) return cached;

  const body: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(spec.body)) {
    body[field] =
      typeof value === 'string' ? value : (await ports.secrets.resolve(value.secret)).expose();
  }

  const outcome = await ports.http.send({
    method: spec.method,
    url: spec.loginUrl,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });

  if (outcome.kind === 'network') {
    ports.metrics.tokenRefresh(1, { pipelineId, outcome: 'fail', reason: outcome.code });
    throw new AuthError(`login falhou: ${outcome.code}`);
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    ports.metrics.tokenRefresh(1, { pipelineId, outcome: 'fail', httpStatus: outcome.status });
    // O corpo da resposta de login costuma ecoar credenciais: nunca vai na mensagem.
    throw new AuthError(`login falhou com HTTP ${outcome.status}`);
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(outcome.body) as JsonValue;
  } catch {
    ports.metrics.tokenRefresh(1, { pipelineId, outcome: 'fail', reason: 'INVALID_JSON' });
    throw new AuthError('resposta do login nao e JSON');
  }

  const token = getPath(parsed, spec.tokenPath);
  if (typeof token !== 'string' || token.length === 0) {
    ports.metrics.tokenRefresh(1, { pipelineId, outcome: 'fail', reason: 'TOKEN_PATH_NOT_FOUND' });
    throw new AuthError(`tokenPath '${spec.tokenPath}' ausente na resposta do login`);
  }

  await ports.cache.set(key, token, spec.ttlSeconds);
  ports.metrics.tokenRefresh(1, { pipelineId, outcome: 'ok' });
  return token;
}

export async function invalidateLoginToken(
  spec: OutboundAuthSpec,
  pipelineId: string,
  cache: TokenCache,
): Promise<void> {
  if (spec.kind === 'login-token') await cache.invalidate(loginCacheKey(pipelineId, spec));
}

/**
 * Comparacao em tempo constante. `===` em string vaza o numero de caracteres
 * corretos pelo tempo de resposta, e o token de entrada e exatamente o segredo
 * que um atacante tentaria adivinhar byte a byte.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige mesmo tamanho; comparar hashes normaliza o tamanho
  // sem revelar o comprimento do segredo pelo caminho de erro.
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

export async function verifyInboundAuth(
  spec: InboundAuthSpec,
  headers: Readonly<Record<string, string>>,
  secrets: SecretResolver,
): Promise<boolean> {
  const presented = headers[spec.header.toLowerCase()];
  if (presented === undefined) return false;

  const expected = await secrets.resolve(spec.token.secret);
  const value =
    spec.scheme === 'bearer' && presented.toLowerCase().startsWith('bearer ')
      ? presented.slice(7).trim()
      : presented.trim();

  return timingSafeEquals(value, expected.expose());
}

/**
 * Materializa Secret em string. E a ULTIMA linha antes do envio, e o unico
 * lugar do sistema onde isso acontece para headers de saida.
 */
export function materializeHeaders(
  headers: Readonly<Record<string, MaybeSecret>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = exposeHeaderValue(value);
  return out;
}
