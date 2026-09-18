import { createHash } from 'node:crypto';
import type { JsonValue } from '../types/json';

// Construido em runtime: um NUL literal no fonte e um byte invisivel que
// quebra editores, diffs e ferramentas de lint.
const NUL = String.fromCharCode(0);

/**
 * Serializacao com ordem de chaves estavel. JSON.stringify comum nao serve para
 * hash de deduplicacao: a ordem das chaves segue a ordem de insercao, entao o
 * mesmo item logico produziria chaves diferentes conforme o parceiro montou o
 * JSON.
 */
export function canonicalize(value: JsonValue | undefined): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashItem(value: JsonValue): string {
  return sha256Hex(canonicalize(value));
}

/**
 * Postgres REJEITA o caractere NUL dentro de strings jsonb. Um parceiro que o
 * mande no payload derruba o INSERT do lote inteiro -- e com
 * ON CONFLICT DO NOTHING em lote perdem-se os 1000 itens, nao um. Sanitizar na
 * borda, antes de chegar ao repositorio.
 */
export function stripNulChars(value: JsonValue): JsonValue {
  if (typeof value === 'string') return value.includes(NUL) ? value.replaceAll(NUL, '') : value;
  if (Array.isArray(value)) return value.map(stripNulChars);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k.replaceAll(NUL, '')] = stripNulChars(v);
    return out;
  }
  return value;
}
