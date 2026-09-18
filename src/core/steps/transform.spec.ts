import type { JsonObject } from '../types/json';
import type { TransformSpec } from '../types/pipeline';
import { applyTransform } from './transform';

/** O transform compilado a partir do YAML do exemplo GTS. */
const GTS_TRANSFORM: TransformSpec = {
  rules: [
    ['agendamento_id', { kind: 'from', path: 'numero_pedido', cast: 'number', hasFallback: false }],
    ['data', { kind: 'from', path: 'data_status', hasFallback: false }],
    ['evento.id', { kind: 'from', path: 'status', hasFallback: false }],
  ],
};

describe('applyTransform', () => {
  it('produz o payload esperado do exemplo do GTS', () => {
    const item: JsonObject = {
      numero_pedido: '884512',
      status: 'LF',
      data_status: '2026-09-17 08:31:00',
      // Campos que a origem traz e o destino nao pediu: nao devem vazar.
      placa: 'ABC1D23',
      motorista: 'ignorado',
    };

    const result = applyTransform(GTS_TRANSFORM)(item);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      agendamento_id: 884512,
      data: '2026-09-17 08:31:00',
      evento: { id: 'LF' },
    });
  });

  it('aninha em notacao de ponto sem sintaxe extra no YAML', () => {
    const spec: TransformSpec = {
      rules: [
        ['a.b.c', { kind: 'const', value: 1 }],
        ['a.b.d', { kind: 'const', value: 2 }],
      ],
    };

    const result = applyTransform(spec)({});

    expect(result.ok && result.value).toEqual({ a: { b: { c: 1, d: 2 } } });
  });

  it('OMITE a chave quando o campo falta e nao ha default', () => {
    const spec: TransformSpec = {
      rules: [['opcional', { kind: 'from', path: 'ausente', hasFallback: false }]],
    };

    const result = applyTransform(spec)({ outro: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nao vira null: enviar null e AFIRMAR um valor, e nem todo destino trata
    // "ausente" e "nulo" da mesma forma.
    expect('opcional' in result.value).toBe(false);
  });

  it('usa o default quando o campo falta', () => {
    const spec: TransformSpec = {
      rules: [['canal', { kind: 'from', path: 'canal', hasFallback: true, fallback: 'WEB' }]],
    };

    expect(applyTransform(spec)({})).toEqual({ ok: true, value: { canal: 'WEB' } });
    expect(applyTransform(spec)({ canal: 'APP' })).toEqual({ ok: true, value: { canal: 'APP' } });
  });

  it('aplica const sem olhar para a origem', () => {
    const spec: TransformSpec = { rules: [['origem', { kind: 'const', value: 'GATEWAY' }]] };
    expect(applyTransform(spec)({ origem: 'outra-coisa' }).ok).toBe(true);
    expect(applyTransform(spec)({ origem: 'outra-coisa' })).toEqual({
      ok: true,
      value: { origem: 'GATEWAY' },
    });
  });

  describe('cast', () => {
    const cast = (kind: 'number' | 'integer' | 'boolean' | 'iso-date' | 'upper', value: unknown) =>
      applyTransform({
        rules: [['v', { kind: 'from', path: 'v', cast: kind, hasFallback: false }]],
      })({
        v: value as never,
      });

    it.each([
      ['number', '884512', 884512],
      ['integer', '42', 42],
      ['boolean', 'sim', true],
      ['boolean', '0', false],
      ['upper', 'lf', 'LF'],
    ] as const)('converte %s(%s) -> %s', (kind, input, expected) => {
      expect(cast(kind, input)).toEqual({ ok: true, value: { v: expected } });
    });

    it('rejeita o item quando o cast e impossivel, em vez de mandar NaN adiante', () => {
      const result = cast('number', 'nao-e-numero');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('TRANSFORM_FAILED');
      expect(result.error.detail).toContain("campo 'v'");
    });
  });

  it('nao escreve em __proto__ nem polui o prototipo', () => {
    const spec: TransformSpec = {
      rules: [['__proto__.poluido', { kind: 'const', value: 'sim' }]],
    };

    applyTransform(spec)({});

    expect(({} as Record<string, unknown>).poluido).toBeUndefined();
  });
});
