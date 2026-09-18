import type { JsonObject, JsonValue } from '../types/json';
import type { CastKind, TransformRule, TransformSpec } from '../types/pipeline';
import { err, ok, type Result } from '../types/result';
import { getPath, setPath } from './path';

export interface TransformError {
  readonly reason: 'TRANSFORM_FAILED';
  readonly detail: string;
}

function applyCast(
  value: JsonValue,
  cast: CastKind,
  path: string,
): Result<JsonValue, TransformError> {
  const fail = (why: string): Result<JsonValue, TransformError> =>
    err({ reason: 'TRANSFORM_FAILED', detail: `campo '${path}': ${why}` });

  switch (cast) {
    case 'string':
      return typeof value === 'object'
        ? fail('valor nao escalar para cast string')
        : ok(String(value));
    case 'number':
    case 'integer': {
      const n = typeof value === 'boolean' ? Number(value) : Number(value);
      if (!Number.isFinite(n)) return fail(`valor '${String(value)}' nao e numero`);
      if (cast === 'integer' && !Number.isInteger(n))
        return fail(`valor '${String(value)}' nao e inteiro`);
      return ok(n);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return ok(value);
      const s = String(value).toLowerCase();
      if (['true', '1', 'sim', 's', 'yes'].includes(s)) return ok(true);
      if (['false', '0', 'nao', 'n', 'no'].includes(s)) return ok(false);
      return fail(`valor '${String(value)}' nao e booleano`);
    }
    case 'iso-date': {
      const d = new Date(typeof value === 'number' ? value : String(value));
      if (Number.isNaN(d.getTime())) return fail(`valor '${String(value)}' nao e data`);
      return ok(d.toISOString());
    }
    case 'epoch-millis': {
      const d = new Date(typeof value === 'number' ? value : String(value));
      if (Number.isNaN(d.getTime())) return fail(`valor '${String(value)}' nao e data`);
      return ok(d.getTime());
    }
    case 'trim':
      return ok(String(value).trim());
    case 'upper':
      return ok(String(value).toUpperCase());
    case 'lower':
      return ok(String(value).toLowerCase());
  }
}

/**
 * Message Translator. Chave de destino em notacao de ponto, para aninhar sem
 * sintaxe extra no YAML.
 *
 * Campo ausente na origem e sem `default` => a chave e OMITIDA do payload. Nao
 * vira `null`: enviar null e afirmar um valor, e nem todo destino trata os dois
 * casos igual.
 */
export function applyTransform(
  spec: TransformSpec,
): (data: JsonObject) => Result<JsonObject, TransformError> {
  return (data) => {
    const out: JsonObject = {};
    for (const [destination, rule] of spec.rules) {
      const resolved = resolveRule(rule, data);
      if (!resolved.ok) return resolved;
      if (resolved.value !== undefined) setPath(out, destination, resolved.value);
    }
    return ok(out);
  };
}

function resolveRule(
  rule: TransformRule,
  data: JsonObject,
): Result<JsonValue | undefined, TransformError> {
  if (rule.kind === 'const') return ok(rule.value);

  const raw = getPath(data, rule.path);
  if (raw === undefined || raw === null) {
    if (rule.hasFallback) return ok(rule.fallback);
    return ok(undefined);
  }
  if (rule.cast === undefined) return ok(raw);
  return applyCast(raw, rule.cast, rule.path);
}
