import { HttpEndpointSource } from '../src/core/source/http-endpoint.source';
import type { Source } from '../src/core/source/source';
import { sha256Hex } from '../src/core/steps/canonical';
import type { RawBatch } from '../src/core/types/event';
import type { CompiledPipeline } from '../src/core/types/pipeline';
import { buildEngine, loadExamplePipelines, type TestEngine } from './fakes/engine';

/**
 * Fonte falsa para o lado do POLL. Produz exatamente o mesmo formato que a
 * HttpPollSource real -- o corpo bruto de uma pagina --, sem precisar de HTTP.
 */
class FakePollSource implements Source {
  constructor(private readonly pages: readonly unknown[]) {}

  async *collect(ctx: {
    beginRun: (input: { trigger: 'POLL'; requestPage: number }) => Promise<RawBatch['run']>;
    clock: { now: () => Date };
  }): AsyncIterable<RawBatch> {
    let page = 0;
    for (const body of this.pages) {
      page += 1;
      const run = await ctx.beginRun({ trigger: 'POLL', requestPage: page });
      yield {
        items: [
          {
            data: body as never,
            receivedAt: ctx.clock.now(),
            index: 0,
            origin: { kind: 'poll', runId: run.id, page, requestUrl: 'https://origem/api' },
          },
        ],
        bodyHash: '',
        run,
        page,
        httpStatus: 200,
      };
    }
  }
}

function pollPage(itens: readonly Record<string, unknown>[]) {
  return { itens: itens, totalRegistros: itens.length };
}

function endpointSource(body: unknown, headers: Record<string, string> = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return new HttpEndpointSource(
    {
      headers,
      sourceIp: '203.0.113.10',
      bodyBytes: raw.byteLength,
      contentType: 'application/json',
      bodyHash: sha256Hex(raw),
    },
    body as never,
  );
}

describe('PipelineRunner', () => {
  let pipelines: Record<string, CompiledPipeline>;
  let engine: TestEngine;

  beforeAll(async () => {
    pipelines = await loadExamplePipelines();
  });

  beforeEach(() => {
    engine = buildEngine();
  });

  const poll = (): CompiledPipeline => pipelines['coleta-paginada'] as CompiledPipeline;
  const endpoint = (): CompiledPipeline => pipelines['recepcao-eventos'] as CompiledPipeline;

  describe('deduplicacao idempotente', () => {
    /**
     * O teste que define o sistema: a mesma coleta rodando duas vezes nao pode
     * gerar duas entregas. Quem decide o que e novo e o banco, via
     * INSERT ... ON CONFLICT DO NOTHING RETURNING.
     */
    it('na entrada por POLL, a segunda passagem nao cria evento nem entrega', async () => {
      const pagina = pollPage([
        { pedido_id: '884512', situacao: 'LIBERADO', atualizado_em: '2026-09-17 08:31:00' },
        { pedido_id: '884513', situacao: 'NOVO', atualizado_em: '2026-09-17 08:32:00' },
      ]);

      const primeira = await engine.runner.run(poll(), new FakePollSource([pagina]));
      const segunda = await engine.runner.run(poll(), new FakePollSource([pagina]));

      expect(primeira.accepted).toBe(2);
      expect(primeira.duplicates).toBe(0);
      expect(primeira.deliveriesCreated).toBe(2);

      expect(segunda.accepted).toBe(0);
      expect(segunda.duplicates).toBe(2);
      expect(segunda.deliveriesCreated).toBe(0);

      expect(engine.events.size).toBe(2);
      expect(engine.deliveries.rows.size).toBe(2);
      expect(engine.queue.enqueued).toHaveLength(2);
    });

    it('na entrada por ENDPOINT, o reenvio devolve o id do evento ORIGINAL', async () => {
      const corpo = { eventos: [{ id_externo: 'E-1', timestamp: '2026-09-17T08:00:00Z' }] };

      const primeira = await engine.runner.run(endpoint(), endpointSource(corpo));
      const reenvio = await engine.runner.run(endpoint(), endpointSource(corpo));

      expect(primeira.accepted).toBe(1);
      expect(reenvio.accepted).toBe(0);
      expect(reenvio.duplicates).toBe(1);

      // Reenvio e comportamento de cliente BEM-COMPORTADO: ele precisa receber
      // de volta o mesmo id, nao um erro.
      const aceito = primeira.outcomes.find((o) => o.status === 'accepted');
      const duplicado = reenvio.outcomes.find((o) => o.status === 'duplicate');
      expect(duplicado?.eventId).toBeDefined();
      expect(duplicado?.eventId).toBe(aceito?.eventId);
    });

    it('deduplica pelo Idempotency-Key mesmo com payload diferente', async () => {
      const headers = { 'idempotency-key': 'IK-42' };

      await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [{ id_externo: 'A' }] }, headers),
      );
      const segunda = await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [{ id_externo: 'B' }] }, headers),
      );

      // O header e a PRIMEIRA alternativa da cadeia: quando ele esta presente,
      // e ele que manda, e o payload nem e consultado.
      expect(segunda.duplicates).toBe(1);
      expect(engine.events.size).toBe(1);
    });

    it('nao conta duplicata intra-lote como evento novo', async () => {
      const item = { id_externo: 'E-9', timestamp: '2026-09-17T08:00:00Z' };

      const result = await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [item, item, item] }),
      );

      expect(result.accepted).toBe(1);
      expect(engine.events.size).toBe(1);
      expect(engine.logger.lines.some((l) => l.level === 'warn')).toBe(true);
    });
  });

  describe('filtro', () => {
    it('descarta status fora da lista antes de gravar qualquer evento', async () => {
      const pagina = pollPage([
        { pedido_id: '1', situacao: 'LIBERADO', atualizado_em: 'x' },
        { pedido_id: '2', situacao: 'RECUSADO', atualizado_em: 'x' },
        { pedido_id: '3', situacao: 'ENTREGUE', atualizado_em: 'x' },
      ]);

      const result = await engine.runner.run(poll(), new FakePollSource([pagina]));

      expect(result.received).toBe(3);
      expect(result.filteredOut).toBe(1);
      expect(result.accepted).toBe(2);
      expect(engine.events.size).toBe(2);
      expect(result.outcomes.filter((o) => o.status === 'filtered')).toHaveLength(1);
    });
  });

  describe('splitter', () => {
    it('quebra o array de itemsPath em um evento por item', async () => {
      const result = await engine.runner.run(
        poll(),
        new FakePollSource([
          pollPage([
            { pedido_id: '1', situacao: 'LIBERADO' },
            { pedido_id: '2', situacao: 'NOVO' },
            { pedido_id: '3', situacao: 'EM_TRANSITO' },
          ]),
        ]),
      );

      expect(result.received).toBe(3);
      expect(result.accepted).toBe(3);
    });

    it('agrega varias paginas numa unica execucao', async () => {
      const result = await engine.runner.run(
        poll(),
        new FakePollSource([
          pollPage([{ pedido_id: '1', situacao: 'LIBERADO' }]),
          pollPage([{ pedido_id: '2', situacao: 'LIBERADO' }]),
        ]),
      );

      expect(result.pages).toBe(2);
      expect(result.accepted).toBe(2);
      // Uma linha de auditoria POR PAGINA: e a unidade de entrada do poll.
      expect(engine.runs.runs).toHaveLength(2);
    });
  });

  describe('fan-out', () => {
    it('cria uma entrega por (evento x destino) com jobId deterministico', async () => {
      await engine.runner.run(
        poll(),
        new FakePollSource([pollPage([{ pedido_id: '1', situacao: 'LIBERADO' }])]),
      );

      expect(engine.queue.enqueued).toHaveLength(1);
      const spec = engine.queue.enqueued[0];
      // d:<delivery_id>:<enqueue_seq> -- o seq comeca em 0 e so avanca quando
      // uma encarnacao anterior do job fica terminal na fila.
      expect(spec?.jobId).toMatch(/^d:[0-9a-f-]{36}:0$/);
      expect(spec?.attempts).toBe(5);
    });

    it('a entrega nasce com o created_at do EVENTO, nao com now()', async () => {
      await engine.runner.run(
        poll(),
        new FakePollSource([pollPage([{ pedido_id: '1', situacao: 'LIBERADO' }])]),
      );

      const delivery = [...engine.deliveries.rows.values()][0];
      const runCreatedAt = engine.runs.runs[0]?.ref.createdAt;
      // Isto e o que mantem evento e entregas na MESMA particao mensal e faz a
      // busca por dedupe_key podar identicamente nas duas tabelas.
      expect(delivery?.createdAt).toEqual(runCreatedAt);
    });

    it('a URL gravada na entrega nao carrega credencial', async () => {
      await engine.runner.run(
        poll(),
        new FakePollSource([pollPage([{ pedido_id: '1', situacao: 'LIBERADO' }])]),
      );

      const delivery = [...engine.deliveries.rows.values()][0];
      expect(delivery?.requestUrl).not.toContain('token');
      expect(delivery?.requestUrl).toBe('https://destino.exemplo.test/eventos');
    });
  });

  describe('a fila e aceleracao, nao garantia', () => {
    /**
     * A regra que sustenta o 202 do endpoint: o evento ja esta no Postgres
     * quando o enfileiramento acontece. Se o Redis estiver fora, o drenador
     * encontra as linhas PENDING -- perder Redis custa ATRASO, nao evento.
     */
    it('o evento e a entrega persistem mesmo quando o enfileiramento falha', async () => {
      engine.queue.shouldFail = true;

      const result = await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [{ id_externo: 'E-1' }] }),
      );

      expect(result.accepted).toBe(1);
      expect(result.deliveriesCreated).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(engine.events.size).toBe(1);
      expect(engine.deliveries.rows.size).toBe(1);
      expect(engine.logger.lines.some((l) => l.level === 'warn')).toBe(true);
    });
  });

  describe('itens sem chave de deduplicacao', () => {
    it('rejeita o item e deixa os demais passarem', async () => {
      const result = await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [{ id_externo: 'E-1' }, { sem_chave: true }] }),
      );

      // Um throw no meio do lote jogaria o item bom fora junto com o ruim.
      expect(result.accepted).toBe(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toBe('DEDUPE_KEY_MISSING');
    });
  });

  describe('a entrada nunca chama o destino', () => {
    it('nenhuma requisicao de saida acontece durante a ingestao', async () => {
      // O motor nao recebe HttpClient nenhum: a ausencia da porta e o que torna
      // a entrega inline impossivel, em vez de apenas desencorajada.
      const result = await engine.runner.run(
        endpoint(),
        endpointSource({ eventos: [{ id_externo: 'E-1' }] }),
      );

      expect(result.deliveriesCreated).toBe(1);
      expect(engine.deliveries.statusOf([...engine.deliveries.rows.keys()][0] as never)).toBe(
        'PENDING',
      );
    });
  });
});
