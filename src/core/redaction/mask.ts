import type { JsonValue } from '../types/json';
import type { LoggableError, Masked } from '../types/masked';
import { Secret } from '../types/secret';
import { maskValue, type SecretRegistry, secretRegistry } from './secret-registry';

/** Headers cujo valor inteiro e credencial. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-apikey',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-authorization',
  'x-access-token',
  'cookie',
  'set-cookie',
  'x-amz-security-token',
]);

/** Parametros de query e chaves de corpo que carregam credencial. */
const SECRET_KEY_PATTERN =
  /(pass|senha|secret|token|credential|authorization|api[-_]?key|^key$|^sig$|signature|client[-_]?secret)/i;

const MAX_STRING = 2_000;

function mark<T>(value: T): Masked<T> {
  return value as Masked<T>;
}

function scrub(input: string, registry: SecretRegistry): string {
  const scrubbed = registry.scrub(input);
  return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}...[truncado]` : scrubbed;
}

/**
 * `Authorization: Basic <base64>` e mascarado POR INTEIRO. Mascarar apenas o que
 * vem depois dos dois-pontos nao adianta: o base64 codifica `usuario:senha`
 * junto, entao qualquer parte dele revela a senha.
 */
export function maskHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  registry: SecretRegistry = secretRegistry,
): Masked<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;

    if (SECRET_HEADERS.has(key) || SECRET_KEY_PATTERN.test(key)) {
      const [scheme] = value.split(' ');
      // Preserva o esquema (util em diagnostico), esconde tudo o mais.
      out[key] =
        scheme !== undefined && /^(bearer|basic|digest)$/i.test(scheme)
          ? `${scheme} ${maskValue(value)}`
          : maskValue(value);
      continue;
    }
    out[key] = scrub(value, registry);
  }
  return mark(out);
}

/**
 * Reescreve a query string e ZERA o userinfo (`https://user:pass@host/`), que e
 * o caso quase sempre esquecido porque nao parece um header nem um campo.
 */
export function maskUrl(url: string, registry: SecretRegistry = secretRegistry): Masked<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return mark(scrub(url, registry));
  }

  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_KEY_PATTERN.test(key))
      parsed.searchParams.set(key, maskValue(parsed.searchParams.get(key) ?? ''));
  }
  return mark(scrub(parsed.toString(), registry));
}

export function maskBody(
  body: unknown,
  registry: SecretRegistry = secretRegistry,
  depth = 0,
): Masked<JsonValue> {
  if (depth > 8) return mark('[profundidade excedida]' as JsonValue);
  if (body instanceof Secret) return mark(body.toJSON() as JsonValue);
  if (body === null || body === undefined) return mark(null);
  if (typeof body === 'string') return mark(scrub(body, registry) as JsonValue);
  if (typeof body === 'number' || typeof body === 'boolean') return mark(body as JsonValue);
  if (Array.isArray(body))
    return mark(body.map((v) => maskBody(v, registry, depth + 1)) as JsonValue);
  if (typeof body !== 'object') return mark(String(body) as JsonValue);

  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? (maskValue(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')) as JsonValue)
      : maskBody(value, registry, depth + 1);
  }
  return mark(out as JsonValue);
}

/**
 * Monta o erro campo a campo de proposito: `message` e `stack` de um Error nao
 * sao enumeraveis, entao `{ ...err }` produz um objeto vazio e o log perde
 * exatamente a informacao pela qual foi escrito. E `cause`/`options` dos erros
 * do undici carregam headers de requisicao inteiros.
 */
export function maskError(
  input: unknown,
  registry: SecretRegistry = secretRegistry,
  depth = 0,
): Masked<LoggableError> {
  if (depth > 4) return mark({ name: 'Error', message: '[cause aninhada demais]' });

  if (!(input instanceof Error)) {
    return mark({ name: 'NonError', message: scrub(String(input), registry) });
  }

  const withCode = input as Error & {
    code?: unknown;
    status?: unknown;
    url?: unknown;
    responseBody?: unknown;
  };
  const base: LoggableError = {
    name: input.name,
    message: scrub(input.message, registry),
    ...(input.stack !== undefined ? { stack: scrub(input.stack, registry) } : {}),
    ...(typeof withCode.code === 'string' ? { code: withCode.code } : {}),
    ...(input.cause !== undefined && input.cause !== null
      ? { cause: maskError(input.cause, registry, depth + 1) }
      : {}),
    ...(typeof withCode.status === 'number' && typeof withCode.url === 'string'
      ? {
          http: {
            status: withCode.status,
            url: maskUrl(withCode.url, registry),
            ...(typeof withCode.responseBody === 'string'
              ? { responseSnippet: scrub(withCode.responseBody.slice(0, 500), registry) }
              : {}),
          },
        }
      : {}),
  };
  return mark(base);
}

export function maskContext(
  context: Readonly<Record<string, unknown>>,
  registry: SecretRegistry = secretRegistry,
): Masked<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? maskValue(typeof value === 'string' ? value : String(value))
      : maskBody(value, registry);
  }
  return mark(out);
}

/** Escapa para os poucos casos em que o valor ja e comprovadamente seguro. */
export function alreadySafe<T>(value: T): Masked<T> {
  return mark(value);
}
