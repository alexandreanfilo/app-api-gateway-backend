import type { RawItem } from '../types/event';
import { asRunId } from '../types/ids';
import type { JsonObject } from '../types/json';
import type { DedupeSpec } from '../types/pipeline';
import { buildDedupeKey } from './dedupe';

const pollOrigin = {
  kind: 'poll',
  runId: asRunId('run'),
  page: 1,
  requestUrl: 'https://x',
} as const;

function pollItem(data: JsonObject): RawItem {
  return { data, receivedAt: new Date(), origin: pollOrigin, index: 0 };
}

function endpointItem(data: JsonObject, headers: Record<string, string> = {}): RawItem {
  return {
    data,
    receivedAt: new Date(),
    index: 0,
    origin: {
      kind: 'endpoint',
      runId: asRunId('run'),
      headers,
      sourceIp: '10.0.0.1',
      bodyBytes: 10,
    },
  };
}

/** Compilado de `dedupe: { fields: [numero_pedido, status] }` (poll). */
const COMPOSITE: DedupeSpec = {
  alternatives: [
    [
      { kind: 'field', path: 'numero_pedido' },
      { kind: 'field', path: 'status' },
    ],
  ],
  onMissing: 'reject',
  ttlDays: 90,
};

/** Compilado de `dedupe: { header: Idempotency-Key, fields: [id_externo] }`. */
const CHAIN: DedupeSpec = {
  alternatives: [
    [{ kind: 'header', name: 'Idempotency-Key' }],
    [{ kind: 'field', path: 'id_externo' }],
  ],
  onMissing: 'reject',
  ttlDays: 90,
};

describe('buildDedupeKey', () => {
  it('e estavel para o mesmo item e diferente entre itens distintos', () => {
    const a = buildDedupeKey(COMPOSITE)(pollItem({ numero_pedido: '1', status: 'LF' }));
    const b = buildDedupeKey(COMPOSITE)(pollItem({ numero_pedido: '1', status: 'LF' }));
    const c = buildDedupeKey(COMPOSITE)(pollItem({ numero_pedido: '1', status: 'CH' }));

    expect(a.ok && b.ok && a.value.dedupeKey).toBe(b.ok ? b.value.dedupeKey : '');
    expect(a.ok && c.ok && a.value.dedupeKey === c.value.dedupeKey).toBe(false);
  });

  it('grava sempre o sha256, nunca o valor bruto', () => {
    const result = buildDedupeKey(COMPOSITE)(pollItem({ numero_pedido: '884512', status: 'LF' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 64 hex: tamanho previsivel no indice mais quente do sistema, e nao estoura
    // o limite de 2704 bytes do btree por mais composta que a chave seja.
    expect(result.value.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    // O valor legivel fica em dedupeSource, que e o que o suporte procura.
    expect(result.value.dedupeSource).toBe('field:numero_pedido=884512|field:status=LF');
  });

  it('no poll, exige TODOS os campos da chave composta', () => {
    const result = buildDedupeKey(COMPOSITE)(pollItem({ numero_pedido: '1' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('DEDUPE_KEY_MISSING');
  });

  it('nao colide entre caminhos diferentes com os mesmos valores', () => {
    const a = buildDedupeKey({ ...COMPOSITE, alternatives: [[{ kind: 'field', path: 'a' }]] })(
      pollItem({ a: 'x' }),
    );
    const b = buildDedupeKey({ ...COMPOSITE, alternatives: [[{ kind: 'field', path: 'b' }]] })(
      pollItem({ b: 'x' }),
    );

    // O nome do campo entra no material do hash: sem isso, `a=x` e `b=x`
    // gerariam a mesma chave e um evento sumiria como "duplicata".
    expect(a.ok && b.ok && a.value.dedupeKey === b.value.dedupeKey).toBe(false);
  });

  describe('no endpoint, header e payload sao alternativas em cadeia', () => {
    it('usa o header quando ele esta presente', () => {
      const result = buildDedupeKey(CHAIN)(
        endpointItem({ id_externo: 'E-1' }, { 'idempotency-key': 'IK-1' }),
      );
      expect(result.ok && result.value.dedupeSource).toBe('header:idempotency-key=IK-1');
    });

    it('cai para o campo do payload quando o header falta', () => {
      const result = buildDedupeKey(CHAIN)(endpointItem({ id_externo: 'E-1' }));
      expect(result.ok && result.value.dedupeSource).toBe('field:id_externo=E-1');
    });

    it('rejeita quando as duas faltam e onMissing e reject', () => {
      const result = buildDedupeKey(CHAIN)(endpointItem({ outro: 1 }));
      expect(result.ok).toBe(false);
    });

    it('com onMissing generate, usa o hash do item cru', () => {
      const spec = { ...CHAIN, onMissing: 'generate' as const };
      const a = buildDedupeKey(spec)(endpointItem({ nome: 'x', valor: 1 }));
      // Mesmo conteudo, ordem de chaves diferente: a canonicalizacao precisa
      // enxergar os dois como o MESMO item, senao "generate" nao deduplica nada.
      const b = buildDedupeKey(spec)(endpointItem({ valor: 1, nome: 'x' }));
      const c = buildDedupeKey(spec)(endpointItem({ nome: 'y', valor: 1 }));

      expect(a.ok && b.ok && a.value.dedupeKey).toBe(b.ok ? b.value.dedupeKey : '');
      expect(a.ok && c.ok && a.value.dedupeKey === c.value.dedupeKey).toBe(false);
    });
  });

  it('ignora diferenca de caixa no nome do header', () => {
    const result = buildDedupeKey(CHAIN)(endpointItem({}, { 'idempotency-key': 'IK-9' }));
    expect(result.ok).toBe(true);
  });
});
