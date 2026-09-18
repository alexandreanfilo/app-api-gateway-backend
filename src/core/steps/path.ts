import { isJsonObject, type JsonObject, type JsonValue } from '../types/json';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `set(obj, '__proto__.x', v)` compromete o processo inteiro, e um YAML e dado
 * de configuracao que pode vir de fora do time. O Zod ja rejeita estes
 * segmentos, mas a funcao tambem os recusa: uma unica defesa num caminho destes
 * e uma defesa a menos do que o necessario.
 */
export function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && !FORBIDDEN_SEGMENTS.has(segment);
}

/** Aceita `a.b`, `a[0].b` e `a.0.b`. */
export function parsePath(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split('.')) {
    for (const m of raw.matchAll(/([^[\]]+)|\[(\d+)\]/g)) {
      const segment = m[1] ?? m[2];
      if (segment !== undefined) segments.push(segment);
    }
  }
  return segments;
}

export function getPath(source: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = source;
  for (const segment of parsePath(path)) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    if (!isSafeSegment(segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Escreve em notacao de ponto, criando os objetos intermediarios. E o que
 * permite `evento.id` aninhar no payload de saida sem sintaxe extra no YAML.
 */
export function setPath(target: JsonObject, path: string, value: JsonValue): void {
  const segments = parsePath(path);
  const last = segments.pop();
  if (last === undefined || !isSafeSegment(last)) return;

  let cursor: JsonObject = target;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) return;
    const next = cursor[segment];
    if (!isJsonObject(next)) {
      const created: JsonObject = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[last] = value;
}
