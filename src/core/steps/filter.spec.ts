import type { RawItem } from '../types/event';
import { asRunId } from '../types/ids';
import type { JsonObject } from '../types/json';
import type { FilterSpec } from '../types/pipeline';
import { applyFilters, matchesFilter } from './filter';

const origin = { kind: 'poll', runId: asRunId('run'), page: 1, requestUrl: 'https://x' } as const;

function item(data: JsonObject, index: number): RawItem {
  return { data, receivedAt: new Date('2026-09-17T12:00:00Z'), origin, index };
}

/** Compilado de `filter: { status: [NP, LF, TP, CH] }`. */
const GTS_FILTER: FilterSpec = {
  rules: [{ path: 'status', predicates: [{ kind: 'in', values: ['NP', 'LF', 'TP', 'CH'] }] }],
};

describe('applyFilters', () => {
  it('descarta item com status fora da lista', () => {
    const items = [
      item({ numero_pedido: 1, status: 'NP' }, 0),
      item({ numero_pedido: 2, status: 'XX' }, 1),
      item({ numero_pedido: 3, status: 'CH' }, 2),
      item({ numero_pedido: 4, status: 'CANCELADO' }, 3),
    ];

    const kept = applyFilters(GTS_FILTER)(items);

    expect(kept.map((i) => i.data.numero_pedido)).toEqual([1, 3]);
  });

  it('descarta item cujo campo filtrado nao existe', () => {
    // Deliberado: `status: [NP, LF]` existe para deixar passar SO esses status,
    // e um item sem `status` nao e nenhum deles.
    const kept = applyFilters(GTS_FILTER)([item({ numero_pedido: 1 }, 0)]);
    expect(kept).toHaveLength(0);
  });

  it('exige que TODAS as regras casem (AND entre campos)', () => {
    const spec: FilterSpec = {
      rules: [
        { path: 'status', predicates: [{ kind: 'in', values: ['LF'] }] },
        { path: 'terminal', predicates: [{ kind: 'in', values: ['A', 'B'] }] },
      ],
    };

    const kept = applyFilters(spec)([
      item({ id: 1, status: 'LF', terminal: 'A' }, 0),
      item({ id: 2, status: 'LF', terminal: 'Z' }, 1),
      item({ id: 3, status: 'NP', terminal: 'A' }, 2),
    ]);

    expect(kept.map((i) => i.data.id)).toEqual([1]);
  });

  it('sem regras, deixa tudo passar', () => {
    const items = [item({ id: 1 }, 0), item({ id: 2 }, 1)];
    expect(applyFilters({ rules: [] })(items)).toHaveLength(2);
  });

  it('casa numero com string numerica, porque o YAML nao sabe o tipo da origem', () => {
    const spec: FilterSpec = {
      rules: [{ path: 'codigo', predicates: [{ kind: 'in', values: [10] }] }],
    };
    const kept = applyFilters(spec)([item({ codigo: '10' }, 0), item({ codigo: 10 }, 1)]);
    // Sem isto, `codigo: [10]` no YAML nunca casaria com uma API que devolve
    // `"10"` -- e falharia em silencio, sem erro e sem log.
    expect(kept).toHaveLength(2);
  });

  it('nao coage booleano nem null', () => {
    const spec: FilterSpec = {
      rules: [{ path: 'ativo', predicates: [{ kind: 'in', values: [true] }] }],
    };
    const kept = applyFilters(spec)([
      item({ ativo: 'true' }, 0),
      item({ ativo: 1 }, 1),
      item({ ativo: true }, 2),
    ]);
    // A coercao existe para o caso numero/string de ID, nao como regra geral.
    expect(kept).toHaveLength(1);
    expect(kept[0]?.data.ativo).toBe(true);
  });
});

describe('matchesFilter', () => {
  const only = (spec: FilterSpec, data: JsonObject) => matchesFilter(spec, data);

  describe('numeric', () => {
    /**
     * Vem de `is_numeric($numeroPedido)` no gateway antigo. O `cast: number` do
     * transform também rejeitaria o item, mas tarde -- depois de o evento e as
     * entregas já existirem. Para a chave de negócio, descartar cedo evita lixo
     * nas tabelas.
     */
    const spec: FilterSpec = {
      rules: [{ path: 'numero_pedido', predicates: [{ kind: 'numeric' }] }],
    };

    it.each([
      [42, true],
      ['884512', true],
      ['0', true],
      ['abc', false],
      ['', false],
      ['  ', false],
      [true, false],
      [null, false],
    ])('numeric(%p) = %p', (value, expected) => {
      expect(only(spec, { numero_pedido: value })).toBe(expected);
    });

    it('campo ausente nao e numerico', () => {
      expect(only(spec, {})).toBe(false);
    });
  });

  describe('notEquals', () => {
    // Vem de `$numeroPedido != 0`.
    const spec: FilterSpec = {
      rules: [{ path: 'numero_pedido', predicates: [{ kind: 'notEquals', value: 0 }] }],
    };

    it('descarta o valor proibido e deixa o resto passar', () => {
      expect(only(spec, { numero_pedido: 0 })).toBe(false);
      expect(only(spec, { numero_pedido: 884512 })).toBe(true);
    });

    it('exclui tambem a string "0", como o `!=` do gateway antigo fazia', () => {
      // No PHP, `'0' != 0` e falso. Igualdade estrita aqui mudaria o
      // comportamento da integracao em silencio durante a migracao.
      expect(only(spec, { numero_pedido: '0' })).toBe(false);
    });
  });

  describe('exists', () => {
    it('exists: true exige o campo presente e nao nulo', () => {
      const spec: FilterSpec = {
        rules: [{ path: 'placa', predicates: [{ kind: 'exists', present: true }] }],
      };
      expect(only(spec, { placa: 'ABC1D23' })).toBe(true);
      expect(only(spec, { placa: null })).toBe(false);
      expect(only(spec, {})).toBe(false);
    });

    it('exists: false e o unico predicado que ACEITA campo ausente', () => {
      const spec: FilterSpec = {
        rules: [{ path: 'cancelado_em', predicates: [{ kind: 'exists', present: false }] }],
      };
      expect(only(spec, {})).toBe(true);
      expect(only(spec, { cancelado_em: null })).toBe(true);
      expect(only(spec, { cancelado_em: '2026-09-17' })).toBe(false);
    });
  });

  describe('notIn e equals', () => {
    it('notIn descarta os valores listados', () => {
      const spec: FilterSpec = {
        rules: [
          { path: 'status', predicates: [{ kind: 'notIn', values: ['CANCELADO', 'EXCLUIDO'] }] },
        ],
      };
      expect(only(spec, { status: 'NP' })).toBe(true);
      expect(only(spec, { status: 'CANCELADO' })).toBe(false);
    });

    it('equals casa um valor unico', () => {
      const spec: FilterSpec = {
        rules: [{ path: 'terminal', predicates: [{ kind: 'equals', value: 'PF' }] }],
      };
      expect(only(spec, { terminal: 'PF' })).toBe(true);
      expect(only(spec, { terminal: 'SL' })).toBe(false);
    });
  });

  it('combina predicados do mesmo campo com AND', () => {
    // A regra exata do gateway antigo: numérico E diferente de zero.
    const spec: FilterSpec = {
      rules: [
        {
          path: 'numero_pedido',
          predicates: [{ kind: 'numeric' }, { kind: 'notEquals', value: 0 }],
        },
      ],
    };

    expect(only(spec, { numero_pedido: '41655302' })).toBe(true);
    expect(only(spec, { numero_pedido: 0 })).toBe(false);
    expect(only(spec, { numero_pedido: 'abc' })).toBe(false);
    expect(only(spec, {})).toBe(false);
  });

  it('resolve caminho em notacao de ponto', () => {
    const spec: FilterSpec = {
      rules: [{ path: 'veiculo.tipo', predicates: [{ kind: 'in', values: ['CARRETA'] }] }],
    };
    expect(only(spec, { veiculo: { tipo: 'CARRETA' } })).toBe(true);
    expect(only(spec, { veiculo: { tipo: 'TRUCK' } })).toBe(false);
  });
});
