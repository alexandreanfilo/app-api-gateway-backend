import type { RawItem } from '../types/event';
import type { JsonObject, JsonPrimitive, JsonValue } from '../types/json';
import type { FilterPredicate, FilterSpec } from '../types/pipeline';
import { getPath } from './path';

function isScalar(value: JsonValue | undefined): value is JsonPrimitive {
  return value !== undefined && (value === null || typeof value !== 'object');
}

/**
 * Igualdade estrita, com UMA excecao deliberada: numero e string numerica sao o
 * mesmo valor (`41655302` casa com `'41655302'`).
 *
 * O motivo e concreto. IDs chegam ora como numero, ora como string, dependendo
 * do parceiro -- por isso o transform tem `cast: number`. No YAML, o operador
 * escreve `numero_pedido: [41655302]` naturalmente como numero, e o YAML o
 * parseia como inteiro. Com igualdade estrita, esse filtro simplesmente NUNCA
 * casaria, sem erro e sem log: a falha silenciosa e o risco real aqui, muito
 * mais provavel do que alguem autorizar um tipo que nao pretendia.
 *
 * O gateway antigo comparava com `==` do PHP, que e frouxo: `'0' != 0` e falso,
 * entao ele excluia `'0'`. Coagir numero e string reproduz esse comportamento;
 * a igualdade estrita o mudaria em silencio na migracao.
 *
 * Booleano e null continuam ESTRITOS: `true` nao casa com `'true'` nem com `1`.
 * A coercao existe para um problema especifico, nao como regra geral.
 */
function sameValue(a: JsonPrimitive, b: JsonPrimitive): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return numericStringEquals(b, a);
  if (typeof a === 'string' && typeof b === 'number') return numericStringEquals(a, b);
  return false;
}

function numericStringEquals(text: string, value: number): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === value;
}

function isNumericValue(value: JsonPrimitive): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

function evaluate(predicate: FilterPredicate, value: JsonValue | undefined): boolean {
  if (predicate.kind === 'exists') {
    const present = value !== undefined && value !== null;
    return present === predicate.present;
  }

  // Todo predicado que nao seja `exists: false` exige o campo presente. Campo
  // ausente nao "passa" um filtro: o filtro existe para RESTRINGIR, e um item
  // sem o campo nao satisfaz a restricao.
  if (!isScalar(value) || value === null) return false;

  switch (predicate.kind) {
    case 'in':
      return predicate.values.some((allowed) => sameValue(allowed, value));
    case 'notIn':
      return !predicate.values.some((blocked) => sameValue(blocked, value));
    case 'equals':
      return sameValue(predicate.value, value);
    case 'notEquals':
      return !sameValue(predicate.value, value);
    case 'numeric':
      return isNumericValue(value);
  }
}

/** AND entre as regras, AND entre os predicados de cada regra. */
export function matchesFilter(spec: FilterSpec, data: JsonObject): boolean {
  for (const rule of spec.rules) {
    const value = getPath(data, rule.path);
    for (const predicate of rule.predicates) {
      if (!evaluate(predicate, value)) return false;
    }
  }
  return true;
}

/**
 * Message Filter. Descarta o item que nao casa com `filter`.
 *
 * Roda DEPOIS do splitter: `filter: { status: [NP, TP] }` e uma regra sobre o
 * evento, e o corpo da pagina inteira nao tem `status`.
 */
export function applyFilters(spec: FilterSpec): (items: readonly RawItem[]) => RawItem[] {
  if (spec.rules.length === 0) return (items) => [...items];
  return (items) => items.filter((item) => matchesFilter(spec, item.data));
}
