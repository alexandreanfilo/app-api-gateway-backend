import type { KeyedItem, RawItem } from '../types/event';
import { asDedupeKey } from '../types/ids';
import type { DedupeSpec, KeyPart } from '../types/pipeline';
import { err, ok, type Result } from '../types/result';
import { canonicalize, sha256Hex } from './canonical';
import { getPath } from './path';

export interface DedupeKeyError {
  readonly reason: 'DEDUPE_KEY_MISSING';
  readonly detail: string;
}

function resolvePart(part: KeyPart, item: RawItem): string | undefined {
  if (part.kind === 'header') {
    if (item.origin.kind !== 'endpoint') return undefined;
    return item.origin.headers[part.name.toLowerCase()];
  }
  const value = getPath(item.data, part.path);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return undefined;
  return String(value);
}

function describePart(part: KeyPart): string {
  return part.kind === 'header' ? `header:${part.name.toLowerCase()}` : `field:${part.path}`;
}

/**
 * A chave gravada e SEMPRE o sha256 hex, nunca o valor bruto: o btree tem limite
 * de 2704 bytes que uma chave composta de parceiro estoura, e o indice mais
 * quente do sistema precisa ter tamanho previsivel. `dedupeSource` guarda o
 * valor legivel, que e o que o suporte procura.
 *
 * O nome de cada parte entra no material do hash para que `a=1,b=2` vindo de
 * caminhos diferentes nao colida.
 */
export function buildDedupeKey(
  spec: DedupeSpec,
): (item: RawItem) => Result<KeyedItem, DedupeKeyError> {
  return (item) => {
    for (const alternative of spec.alternatives) {
      const resolved: string[] = [];
      let complete = alternative.length > 0;
      for (const part of alternative) {
        const value = resolvePart(part, item);
        if (value === undefined || value === '') {
          complete = false;
          break;
        }
        resolved.push(`${describePart(part)}=${value}`);
      }
      if (complete) {
        const source = resolved.join('|');
        return ok({ dedupeKey: asDedupeKey(sha256Hex(source)), dedupeSource: source, item });
      }
    }

    if (spec.onMissing === 'generate') {
      // Hash do item cru: reenvio do payload identico ainda deduplica, que e o
      // motivo de a deduplicacao existir.
      const source = `sha256(item)=${sha256Hex(canonicalize(item.data))}`;
      return ok({ dedupeKey: asDedupeKey(sha256Hex(source)), dedupeSource: source, item });
    }

    const expected = spec.alternatives.map((a) => a.map(describePart).join('+')).join(' ou ');
    return err({
      reason: 'DEDUPE_KEY_MISSING',
      detail: `nenhuma chave de deduplicacao resolvida (esperado ${expected})`,
    });
  };
}
