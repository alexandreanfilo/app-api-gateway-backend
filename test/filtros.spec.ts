import { join } from 'node:path';
import { loadGatewayConfig } from '../src/config/load-config';
import { HttpEndpointSource } from '../src/core/source/http-endpoint.source';
import { sha256Hex } from '../src/core/steps/canonical';
import type { CompiledPipeline } from '../src/core/types/pipeline';
import { buildEngine, TEST_ENV, TEST_SECRETS } from './fakes/engine';
import { StaticSecretResolver } from './fakes/in-memory-stores';

const SECRETS = new StaticSecretResolver({ FILTROS_TOKEN: 'tok' });

async function loadPipeline(): Promise<CompiledPipeline> {
  const config = await loadGatewayConfig({
    dir: join(__dirname, 'fixtures', 'pipelines', 'filtros'),
    secrets: SECRETS,
    env: TEST_ENV,
  });
  const pipeline = config.pipelines[0];
  if (pipeline === undefined) throw new Error('fixture nao carregou');
  return pipeline;
}

function source(itens: readonly Record<string, unknown>[]) {
  const body = { itens };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return new HttpEndpointSource(
    { headers: {}, sourceIp: '10.0.0.1', bodyBytes: raw.byteLength, bodyHash: sha256Hex(raw) },
    body as never,
  );
}

describe('filtro com predicados', () => {
  it('compila o atalho de lista e a forma com predicados para a mesma estrutura', async () => {
    const pipeline = await loadPipeline();

    // O motor nao sabe qual das duas formas o operador escreveu: `status: [NOVO, EM_TRANSITO]`
    // vira exatamente o mesmo `{ kind: 'in' }` que a forma longa produziria.
    expect(pipeline.downstream.filter.rules).toEqual([
      { path: 'situacao', predicates: [{ kind: 'in', values: ['NOVO', 'EM_TRANSITO'] }] },
      {
        path: 'pedido_id',
        predicates: [{ kind: 'notEquals', value: 0 }, { kind: 'numeric' }],
      },
    ]);
  });

  it('descarta item invalido sem gravar evento nenhum', async () => {
    const pipeline = await loadPipeline();
    const engine = buildEngine();

    const result = await engine.runner.run(
      pipeline,
      source([
        { pedido_id: '884512', situacao: 'NOVO' }, // passa
        { pedido_id: '0', situacao: 'NOVO' }, //     notEquals: 0
        { pedido_id: 0, situacao: 'NOVO' }, //       notEquals: 0
        { pedido_id: 'abc', situacao: 'NOVO' }, //   numeric
        { pedido_id: '884513', situacao: 'XX' }, // status
        { pedido_id: '884514', situacao: 'EM_TRANSITO' }, // passa
      ]),
    );

    expect(result.received).toBe(6);
    expect(result.filteredOut).toBe(4);
    expect(result.accepted).toBe(2);
    // O ponto de filtrar cedo: nenhum evento nem entrega criados para o lixo.
    expect(engine.events.size).toBe(2);
  });
});

describe('roteamento por destino (Content-Based Router)', () => {
  it('destino sem filtro recebe tudo; destino com filtro so recebe o que casa', async () => {
    const pipeline = await loadPipeline();
    const engine = buildEngine();

    await engine.runner.run(
      pipeline,
      source([
        { pedido_id: '41655302', situacao: 'NOVO' }, // casa o espelho
        { pedido_id: '884512', situacao: 'NOVO' }, //   nao casa
      ]),
    );

    const porDestino = [...engine.deliveries.rows.values()].reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.destinationId] = (acc[row.destinationId] ?? 0) + 1;
        return acc;
      },
      {},
    );

    expect(porDestino).toEqual({ principal: 2, espelho: 1 });
  });

  it('nao cria linha de entrega para o destino que nao casa', async () => {
    const pipeline = await loadPipeline();
    const engine = buildEngine();

    const result = await engine.runner.run(
      pipeline,
      source([{ pedido_id: '884512', situacao: 'NOVO' }]),
    );

    // Uma entrega, nao duas: a linha que nasceria para ser descartada nem existe.
    expect(result.deliveriesCreated).toBe(1);
    expect(engine.queue.enqueued).toHaveLength(1);
  });

  it('o filtro do destino nao interfere no evento nem nos outros destinos', async () => {
    const pipeline = await loadPipeline();
    const engine = buildEngine();

    const result = await engine.runner.run(
      pipeline,
      source([{ pedido_id: '884512', situacao: 'NOVO' }]),
    );

    expect(result.accepted).toBe(1);
    expect(engine.events.size).toBe(1);
  });
});

// Mantem TEST_SECRETS em uso para os demais fixtures continuarem coerentes.
void TEST_SECRETS;
