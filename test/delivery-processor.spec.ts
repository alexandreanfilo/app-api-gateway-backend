import type { Job } from 'bullmq';
import { PipelineRegistry } from '../src/config/pipeline-registry';
import type { DeliveryJobData } from '../src/core/ports/delivery-queue';
import type { HttpOutcome } from '../src/core/ports/http-client';
import { asDeliveryId, asDestinationId, asEventId, asPipelineId } from '../src/core/types/ids';
import type { CompiledPipeline } from '../src/core/types/pipeline';
import {
  DeliveryExhaustedError,
  DeliveryProcessor,
  RetryableDeliveryError,
} from '../src/queue/delivery.processor';
import type { JobEnvelope } from '../src/queue/otel-envelope';
import type { RuntimeConfig } from '../src/runtime.tokens';
import { FixedClock } from './fakes/clock';
import { loadExamplePipelines, TEST_SECRETS } from './fakes/engine';
import {
  InMemoryDeliveryStore,
  InMemoryEventStore,
  InMemoryTokenCache,
  jsonResponse,
  RecordingHttpClient,
} from './fakes/in-memory-stores';
import { RecordingLogger, RecordingMetrics } from './fakes/observability';

const CREATED_AT = new Date('2026-09-17T12:00:00.000Z');
const RUNTIME = { workerId: 'worker-de-teste' } as RuntimeConfig;

function job(data: DeliveryJobData): Job<JobEnvelope<DeliveryJobData>> {
  return {
    id: 'job-1',
    attemptsMade: 0,
    data: { otel: {}, payload: data },
  } as Job<JobEnvelope<DeliveryJobData>>;
}

describe('DeliveryProcessor', () => {
  let pipelines: Record<string, CompiledPipeline>;

  beforeAll(async () => {
    pipelines = await loadExamplePipelines();
  });

  function build(responder: (url: string) => HttpOutcome, registryPipelines?: CompiledPipeline[]) {
    const pipeline = pipelines['recepcao-eventos'] as CompiledPipeline;
    const deliveries = new InMemoryDeliveryStore();
    const events = new InMemoryEventStore();
    const http = new RecordingHttpClient((req) => responder(req.url));
    const metrics = new RecordingMetrics();
    const logger = new RecordingLogger();

    const processor = new DeliveryProcessor(
      new PipelineRegistry(registryPipelines ?? [pipeline]),
      deliveries,
      events,
      http,
      TEST_SECRETS,
      new InMemoryTokenCache(),
      new FixedClock(CREATED_AT),
      logger,
      metrics,
      RUNTIME,
    );

    return { processor, deliveries, events, http, metrics, logger, pipeline };
  }

  async function seed(ctx: Awaited<ReturnType<typeof build>>, maxAttempts = 3) {
    const inserted = await ctx.events.insertNewOnly([
      {
        pipelineId: ctx.pipeline.id,
        dedupeKey: 'k1' as never,
        dedupeSource: 'field:id_externo=E-1',
        runId: 'run' as never,
        runCreatedAt: CREATED_AT,
        payload: { id_externo: 'E-1', timestamp: '2026-09-17T08:00:00Z' },
      },
    ]);
    const eventId = inserted.inserted[0]?.id ?? asEventId('x');
    const id = asDeliveryId('11111111-1111-7111-8111-111111111111');

    await ctx.deliveries.createMany([
      {
        id,
        createdAt: CREATED_AT,
        pipelineId: ctx.pipeline.id,
        destinationId: asDestinationId('destino-b'),
        eventId,
        dedupeKey: 'k1' as never,
        maxAttempts,
        nextAttemptAt: CREATED_AT,
        requestMethod: 'POST',
        requestUrl: 'https://destino.exemplo.test/recebidos',
      },
    ]);

    return {
      id,
      data: {
        deliveryId: id,
        createdAt: CREATED_AT.toISOString(),
        pipelineId: ctx.pipeline.id,
        destinationId: asDestinationId('destino-b'),
      } satisfies DeliveryJobData,
    };
  }

  it('entrega com sucesso e grava DELIVERED', async () => {
    const ctx = build(() => jsonResponse(200, { ok: true }));
    const { id, data } = await seed(ctx);

    await ctx.processor.process(job(data));

    expect(ctx.deliveries.statusOf(id)).toBe('DELIVERED');
    expect(ctx.http.requests).toHaveLength(1);
  });

  it('renderiza o corpo com o transform do YAML, na hora do envio', async () => {
    const ctx = build(() => jsonResponse(200));
    const { data } = await seed(ctx);

    await ctx.processor.process(job(data));

    // Corpo renderizado AGORA, nao materializado no fan-out: e o que faz
    // corrigir o transform no YAML consertar as retentativas pendentes.
    expect(JSON.parse(ctx.http.requests[0]?.body ?? '{}')).toEqual({
      evento_id: 'E-1',
      ocorrido_em: '2026-09-17T08:00:00Z',
    });
  });

  it('manda Idempotency-Key com o id da entrega', async () => {
    const ctx = build(() => jsonResponse(200));
    const { id, data } = await seed(ctx);

    await ctx.processor.process(job(data));

    // Unica defesa contra a duplicata irredutivel: crash entre o 200 do destino
    // e o UPDATE que grava DELIVERED.
    expect(ctx.http.requests[0]?.headers['idempotency-key']).toBe(id);
  });

  it('a credencial vai no header como Secret, nunca como string solta', async () => {
    const ctx = build(() => jsonResponse(200));
    const { data } = await seed(ctx);

    await ctx.processor.process(job(data));

    const auth = ctx.http.requests[0]?.headers.authorization;
    // Serializar o header de saida nao pode revelar o token.
    expect(JSON.stringify(auth)).not.toContain('token-do-destino-b');
    expect(String(auth)).toContain('[secret:');
  });

  describe('classificacao do resultado', () => {
    it('4xx definitivo -> DISCARDED e o job COMPLETA (nao lanca)', async () => {
      const ctx = build(() => jsonResponse(422, { erro: 'campo invalido' }));
      const { id, data } = await seed(ctx);

      // Lancar faria o BullMQ retentar aquilo que jamais sera retentado.
      await expect(ctx.processor.process(job(data))).resolves.toBeUndefined();
      expect(ctx.deliveries.statusOf(id)).toBe('DISCARDED');
      expect(ctx.deliveries.discardReasonOf(id)).toBe('NON_RETRYABLE_STATUS');
    });

    it('5xx -> FAILED e lanca erro retentavel com o atraso calculado', async () => {
      const ctx = build(() => jsonResponse(503));
      const { id, data } = await seed(ctx);

      await expect(ctx.processor.process(job(data))).rejects.toBeInstanceOf(RetryableDeliveryError);
      expect(ctx.deliveries.statusOf(id)).toBe('FAILED');
    });

    it('esgotar tentativas -> DISCARDED e lanca, para o job ficar em `failed`', async () => {
      const ctx = build(() => jsonResponse(503));
      const { id, data } = await seed(ctx, 1);

      await expect(ctx.processor.process(job(data))).rejects.toBeInstanceOf(DeliveryExhaustedError);
      expect(ctx.deliveries.statusOf(id)).toBe('DISCARDED');
      expect(ctx.deliveries.discardReasonOf(id)).toBe('ATTEMPTS_EXHAUSTED');
    });
  });

  describe('configuracao divergente entre instancias', () => {
    /**
     * A distincao que custou um bug real: uma replica que nao tem o YAML de um
     * pipeline NAO pode descartar a entrega. Num deploy rolante, a replica
     * antiga ve na fila entregas de um pipeline novo, e descartar ali seria
     * destruir o evento de outra replica com base na propria ignorancia.
     */
    it('pipeline desconhecido -> devolve para nova tentativa, sem tocar na linha', async () => {
      const ctx = build(() => jsonResponse(200));
      const { id, data } = await seed(ctx);

      const orfao = build(() => jsonResponse(200), []);
      await expect(
        orfao.processor.process(job({ ...data, pipelineId: asPipelineId('outro-pipeline') })),
      ).rejects.toBeInstanceOf(RetryableDeliveryError);

      // A linha original continua intacta, esperando quem saiba entrega-la.
      expect(ctx.deliveries.statusOf(id)).toBe('PENDING');
    });

    it('destino removido de um pipeline CONHECIDO -> DISCARDED', async () => {
      const ctx = build(() => jsonResponse(200));
      const { id, data } = await seed(ctx);

      await ctx.processor.process(job({ ...data, destinationId: asDestinationId('sumiu') }));

      // Aqui a remocao foi deliberada, no YAML: terminal e correto.
      expect(ctx.deliveries.discardReasonOf(id)).toBe('DESTINATION_REMOVED');
    });
  });

  it('nao entrega duas vezes quando o claim e perdido', async () => {
    const ctx = build(() => jsonResponse(200));
    const { id, data } = await seed(ctx);

    await ctx.processor.process(job(data));
    // Segunda encarnacao do mesmo job: a linha ja e terminal, o claim falha, e o
    // worker retorna em silencio em vez de lancar.
    await expect(ctx.processor.process(job(data))).resolves.toBeUndefined();

    expect(ctx.http.requests).toHaveLength(1);
    expect(ctx.deliveries.statusOf(id)).toBe('DELIVERED');
  });
});
