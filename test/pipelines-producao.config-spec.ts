import { join } from 'node:path';
import { loadGatewayConfig } from '../src/config/load-config';
import type { SecretResolver } from '../src/core/ports/secret-resolver';
import type { CompiledPipeline, CompiledPollSource } from '../src/core/types/pipeline';
import { TEST_ENV } from './fakes/engine';

/**
 * Trava os pipelines REAIS de `pipelines/` contra a semantica dos mappings PHP
 * que eles substituem.
 *
 * Os mappings antigos eram closures avaliadas com eval(), guardadas no banco de
 * producao -- nao ha diff nem code review possivel sobre eles. Este arquivo e o
 * unico lugar onde a equivalencia fica registrada e verificavel: se alguem
 * mexer na janela de datas, na lista de status ou no payload de saida, o teste
 * cai antes do deploy, e nao semanas depois como evento faltando no TSM.
 */
/**
 * Aceita qualquer nome de segredo, de proposito.
 *
 * O que este arquivo trava e a FORMA COMPILADA dos fluxos migrados -- url,
 * filtro, transform, dedupe. Se ele carregasse uma lista fixa de segredos,
 * acrescentar um cliente novo (operacao de rotina, feita so com YAML) quebraria
 * a suite com "segredo nao encontrado", obrigando a editar TypeScript a cada
 * fluxo. Provisionamento de credencial e assunto do ambiente de deploy, nao
 * deste teste.
 *
 * O que importa sobre segredos continua verificado mais abaixo, a partir da
 * configuracao compilada: que cada fluxo usa os seus e nao compartilha com outro.
 */
const SECRETS: SecretResolver = {
  async exists(): Promise<boolean> {
    return true;
  },
  async resolve(nome: string): Promise<never> {
    throw new Error(`este teste nao materializa segredo (${nome})`);
  },
  invalidate(): void {},
  describe(): string {
    return 'teste de configuracao';
  },
};

/** payload do TSM: `["agendamento_id" => (int) $numeroPedido, "data" => $dataStatus, "evento" => ["id" => $status]]` */
const TRANSFORM_TSM = [
  ['agendamento_id', { kind: 'from', path: 'numero_pedido', cast: 'number', hasFallback: false }],
  ['data', { kind: 'from', path: 'data_status', hasFallback: false }],
  ['evento.id', { kind: 'from', path: 'status', hasFallback: false }],
];

/** `if ($numeroPedido != 0 && is_numeric($numeroPedido))` */
const VALIDADE_NUMERO_PEDIDO = {
  path: 'numero_pedido',
  predicates: [{ kind: 'notEquals', value: 0 }, { kind: 'numeric' }],
};

describe('pipelines de producao', () => {
  let porId: Record<string, CompiledPipeline>;

  beforeAll(async () => {
    const config = await loadGatewayConfig({
      dir: join(__dirname, '..', 'pipelines'),
      secrets: SECRETS,
      env: TEST_ENV,
    });
    porId = Object.fromEntries(config.pipelines.map((p) => [p.id, p]));
  });

  const poll = (id: string): CompiledPipeline & { source: CompiledPollSource } => {
    const pipeline = porId[id];
    if (pipeline === undefined) throw new Error(`pipeline '${id}' nao carregou`);
    if (pipeline.source.kind !== 'http-poll') throw new Error(`'${id}' nao e http-poll`);
    return pipeline as CompiledPipeline & { source: CompiledPollSource };
  };

  /**
   * Presenca, nao inventario.
   *
   * Este arquivo existe para travar os fluxos MIGRADOS dos mappings PHP contra a
   * semantica original. Acrescentar um fluxo novo e uma operacao legitima e
   * rotineira -- feita so com YAML, sem tocar em codigo --, entao exigir a lista
   * exata transformaria cada cliente novo numa quebra de teste sem sentido.
   *
   * Um fluxo migrado que SUMIR continua sendo pego: o helper `poll()` lanca, e
   * todos os describes abaixo caem junto.
   */
  it('carrega os fluxos migrados do PHP e ignora o exemplo desabilitado', () => {
    const ids = Object.keys(porId);

    expect(ids).toEqual(
      expect.arrayContaining([
        'adm-porto-franco-grao-tsm',
        'fto-barcarena-fertilizante-tsm',
        'fto-sao-luis-fertilizante-tsm',
      ]),
    );
    // O exemplo do briefing esta `enabled: false` e colide de origem com o
    // fluxo do Barcarena: se voltar a carregar, sao entregas em duplicidade.
    expect(ids).not.toContain('gts-sao-luis-tsm');
  });

  describe.each([
    {
      id: 'adm-porto-franco-grao-tsm',
      url: 'https://portofranco.lyin-s.com/api/list/agendamento_grao/',
      itemsPath: 'agendamento_grao',
      // in_array($status, ['NP', 'TP'])
      status: ['NP', 'TP'],
      origem: 'ADM_PORTO_FRANCO_TOKEN',
      destino: 'ADM_TSM_TOKEN',
    },
    {
      id: 'fto-barcarena-fertilizante-tsm',
      url: 'https://agendamento.lyin-s.com/api/list/agendamento_fertilizante',
      itemsPath: 'agendamento_fertilizante',
      // in_array($status, ['NP', 'LF', 'TP', 'CH'])
      status: ['NP', 'LF', 'TP', 'CH'],
      origem: 'FTO_BARCARENA_TOKEN',
      destino: 'FTO_BARCARENA_TSM_TOKEN',
    },
    {
      id: 'fto-sao-luis-fertilizante-tsm',
      url: 'https://portofranco.lyin-s.com/api/list/agendamento_fertilizante',
      itemsPath: 'agendamento_fertilizante',
      status: ['NP', 'LF', 'TP', 'CH'],
      origem: 'FTO_SAO_LUIS_TOKEN',
      destino: 'FTO_SAO_LUIS_TSM_TOKEN',
    },
  ])('$id', (esperado) => {
    it('consulta a origem certa, com o itemsPath do mapping', () => {
      const pipeline = poll(esperado.id);
      expect(pipeline.source.url).toBe(esperado.url);
      expect(pipeline.downstream.split.itemsPath).toBe(esperado.itemsPath);
      // data_get($response, 'totalRecordCount', 0)
      expect(pipeline.source.totalCountPath).toBe('totalRecordCount');
    });

    it('consulta so a data inicial, com dois dias de recuo', () => {
      const pipeline = poll(esperado.id);
      // Forma do legado preservada: UMA data, sem data final -- a janela de 5
      // dias do exemplo do briefing nao corresponde a nenhum fluxo real.
      //
      // O offset, esse mudou de proposito. `carbon.format('Y-m-d')` mandava o
      // dia corrente, e agendamento criado ou corrigido retroativamente nunca
      // era visto: a consulta seguinte ja perguntava por outro dia. Com
      // {today-2d} o reenvio do que ja passou e absorvido pela deduplicacao,
      // que e barata; a janela curta demais custava evento perdido, que nao e.
      expect(pipeline.source.query).toEqual({ data_inicial_agendamento: '{today-2d}' });
      expect(pipeline.source.timezone).toBe('America/Sao_Paulo');
    });

    it('filtra por status e pela validade do numero_pedido', () => {
      const pipeline = poll(esperado.id);
      expect(pipeline.downstream.filter.rules).toEqual([
        { path: 'status', predicates: [{ kind: 'in', values: esperado.status }] },
        VALIDADE_NUMERO_PEDIDO,
      ]);
    });

    it('produz o payload do TSM', () => {
      expect(poll(esperado.id).downstream.transform.rules).toEqual(TRANSFORM_TSM);
    });

    it('entrega no TSM com token proprio, sem nenhum destino condicional ativo', () => {
      const destinos = poll(esperado.id).downstream.destinations;
      expect(destinos).toHaveLength(1);
      expect(destinos[0]?.url).toBe('https://api.trizy.com.br/tsm-integrator/events');
      // withToken() do Laravel produz `Authorization: Bearer <token>`.
      expect(destinos[0]?.auth).toEqual({
        kind: 'bearer',
        token: { secret: esperado.destino },
      });
      // Os espelhos para webhook.site eram depuracao esquecida em producao.
      expect(destinos[0]?.filter.rules).toEqual([]);
    });

    it('usa credencial propria na origem e no destino, sem compartilhar', () => {
      const pipeline = poll(esperado.id);
      expect(pipeline.source.auth).toEqual({
        kind: 'api-key',
        header: 'X-Authorization',
        value: { secret: esperado.origem },
      });
    });

    it('deduplica por numero_pedido + status', () => {
      // A mesma chave composta que o legado usava implicitamente ao reenviar
      // apenas quando o status mudava.
      expect(poll(esperado.id).downstream.dedupe.alternatives).toEqual([
        [
          { kind: 'field', path: 'numero_pedido' },
          { kind: 'field', path: 'status' },
        ],
      ]);
    });
  });

  it('nenhum par (origem, destino) se repete entre os fluxos', async () => {
    const config = await loadGatewayConfig({
      dir: join(__dirname, '..', 'pipelines'),
      secrets: SECRETS,
      env: TEST_ENV,
    });
    // Dois fluxos na mesma origem entregando no mesmo destino entregariam cada
    // evento duas vezes no TSM.
    expect(config.warnings).toEqual([]);
  });

  it('cada fluxo usa segredos exclusivos', () => {
    const usados = Object.values(porId)
      .filter((p) => p.source.kind === 'http-poll')
      .flatMap((p) => {
        const source = p.source as CompiledPollSource;
        const origem = source.auth.kind === 'api-key' ? source.auth.value.secret : '';
        const destinos = p.downstream.destinations.map((d) =>
          d.auth.kind === 'bearer' ? d.auth.token.secret : '',
        );
        return [origem, ...destinos];
      });

    // Token compartilhado entre clientes significa que revogar um derruba outro.
    expect(new Set(usados).size).toBe(usados.length);
  });
});
