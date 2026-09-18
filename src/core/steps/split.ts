import type { RawBatch, RawItem } from '../types/event';
import type { JsonObject, JsonValue } from '../types/json';
import { isJsonObject } from '../types/json';
import { err, ok, type Result } from '../types/result';
import { getPath } from './path';

export interface SplitError {
  readonly reason: 'ITEMS_PATH_NOT_FOUND';
  readonly detail: string;
}

/**
 * Splitter. `itemsPath` transforma o array em um item por evento; ausente, o
 * corpo inteiro e um item.
 *
 * Caminho presente mas apontando para algo que nao e array e ERRO, nao lista
 * vazia: silenciar isso transformaria um YAML errado em "o parceiro nao mandou
 * nada", que e o diagnostico mais caro possivel.
 */
export function splitBody(
  itemsPath: string | undefined,
  body: JsonValue,
): Result<JsonObject[], SplitError> {
  if (itemsPath === undefined) {
    if (Array.isArray(body)) return ok(body.filter(isJsonObject));
    return isJsonObject(body)
      ? ok([body])
      : err({ reason: 'ITEMS_PATH_NOT_FOUND', detail: 'corpo nao e objeto nem lista de objetos' });
  }

  const found = getPath(body, itemsPath);
  if (found === undefined || found === null) {
    return err({
      reason: 'ITEMS_PATH_NOT_FOUND',
      detail: `itemsPath '${itemsPath}' ausente no corpo`,
    });
  }
  if (!Array.isArray(found)) {
    return isJsonObject(found)
      ? ok([found])
      : err({
          reason: 'ITEMS_PATH_NOT_FOUND',
          detail: `itemsPath '${itemsPath}' nao aponta para objeto ou lista`,
        });
  }
  return ok(found.filter(isJsonObject));
}

/** Aplica o split a um lote ja montado, renumerando os indices. */
export function resplitBatch(itemsPath: string | undefined, batch: RawBatch): RawItem[] {
  if (itemsPath === undefined) return [...batch.items];
  const out: RawItem[] = [];
  for (const item of batch.items) {
    const split = splitBody(itemsPath, item.data);
    if (!split.ok) continue;
    for (const data of split.value) out.push({ ...item, data, index: out.length });
  }
  return out;
}
