import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureHttp } from '../src/bootstrap-http';
import { loadGatewayConfig } from '../src/config/load-config';
import { PIPELINE_REGISTRY, PipelineRegistry } from '../src/config/pipeline-registry';
import { CLOCK } from '../src/core/ports/clock';
import { DELIVERY_QUEUE } from '../src/core/ports/delivery-queue';
import { DELIVERY_STORE } from '../src/core/ports/delivery-store';
import { EVENT_STORE } from '../src/core/ports/event-store';
import { ID_GENERATOR } from '../src/core/ports/id-generator';
import { LOGGER } from '../src/core/ports/logger';
import { METRICS } from '../src/core/ports/metrics';
import { RUN_STORE } from '../src/core/ports/run-store';
import { SECRET_RESOLVER } from '../src/core/ports/secret-resolver';
import { TRACING } from '../src/core/ports/tracing';
import { UNIT_OF_WORK } from '../src/core/ports/unit-of-work';
import { PipelineRunner } from '../src/core/runner/run-pipeline';
import { HealthController } from '../src/http/health.controller';
import { IngressController } from '../src/http/ingress.controller';
import { IngressService } from '../src/http/ingress.service';
import { RateLimiter } from '../src/http/rate-limiter';
import { DATABASE } from '../src/persistence/database';
import { FixedClock } from './fakes/clock';
import { TEST_ENV, TEST_SECRETS } from './fakes/engine';
import { SequentialIdGenerator } from './fakes/id-generator';
import {
  DirectUnitOfWork,
  InMemoryDeliveryStore,
  InMemoryEventStore,
  InMemoryQueue,
  InMemoryRunStore,
} from './fakes/in-memory-stores';
import { PassthroughTracing, RecordingLogger, RecordingMetrics } from './fakes/observability';

const TOKEN = 'chave-da-recepcao';
const ROTA = '/in/recepcao-eventos';

/** Sempre deixa passar: o limite de taxa tem teste proprio. */
class AllowAllRateLimiter {
  async allow(): Promise<boolean> {
    return true;
  }
}

describe('POST /in/:pipeline (e2e)', () => {
  let app: NestExpressApplication;
  let events: InMemoryEventStore;
  let deliveries: InMemoryDeliveryStore;
  let queue: InMemoryQueue;

  beforeEach(async () => {
    const config = await loadGatewayConfig({
      dir: join(__dirname, 'fixtures', 'pipelines', 'valid'),
      secrets: TEST_SECRETS,
      env: TEST_ENV,
    });

    events = new InMemoryEventStore();
    deliveries = new InMemoryDeliveryStore();
    queue = new InMemoryQueue();
    const runs = new InMemoryRunStore();

    @Module({
      controllers: [IngressController, HealthController],
      providers: [
        IngressService,
        { provide: PIPELINE_REGISTRY, useValue: new PipelineRegistry(config.pipelines) },
        { provide: SECRET_RESOLVER, useValue: TEST_SECRETS },
        { provide: EVENT_STORE, useValue: events },
        { provide: DELIVERY_STORE, useValue: deliveries },
        { provide: RUN_STORE, useValue: runs },
        { provide: DELIVERY_QUEUE, useValue: queue },
        { provide: UNIT_OF_WORK, useValue: new DirectUnitOfWork() },
        { provide: ID_GENERATOR, useValue: new SequentialIdGenerator() },
        { provide: CLOCK, useValue: new FixedClock(new Date('2026-09-17T12:00:00Z')) },
        { provide: LOGGER, useValue: new RecordingLogger() },
        { provide: METRICS, useValue: new RecordingMetrics() },
        { provide: TRACING, useValue: new PassthroughTracing() },
        { provide: RateLimiter, useClass: AllowAllRateLimiter },
        { provide: DATABASE, useValue: {} },
        {
          provide: PipelineRunner,
          useFactory: () =>
            new PipelineRunner({
              events,
              deliveries,
              runs,
              queue,
              uow: new DirectUnitOfWork(),
              ids: new SequentialIdGenerator(),
              clock: new FixedClock(new Date('2026-09-17T12:00:00Z')),
              logger: new RecordingLogger(),
              metrics: new RecordingMetrics(),
              tracing: new PassthroughTracing(),
            }),
        },
      ],
    })
    class TestModule {}

    app = await NestFactory.create<NestExpressApplication>(TestModule, {
      bodyParser: false,
      logger: false,
      // Sem isto o Nest chama process.exit(1) e o erro de DI real fica invisivel
      // no relatorio do Jest.
      abortOnError: false,
    });
    // A MESMA funcao do main.ts. Se o express.raw morasse dentro do bootstrap(),
    // este teste exercitaria um caminho diferente do de producao e passaria por
    // engano.
    configureHttp(app, 16 * 1024 * 1024);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post(ROTA)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(body as object);

  it('sem token -> 401, e nada e gravado', async () => {
    const response = await post({ eventos: [{ id_externo: 'E-1' }] });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(events.size).toBe(0);
  });

  it('com token errado -> 401', async () => {
    const response = await post({ eventos: [{ id_externo: 'E-1' }] }, { 'X-Api-Key': 'errado' });
    expect(response.status).toBe(401);
  });

  it('com token -> 202 com o id do evento, e o evento esta gravado', async () => {
    const response = await post({ eventos: [{ id_externo: 'E-1' }] }, { 'X-Api-Key': TOKEN });

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(1);
    expect(response.body.items[0]).toMatchObject({ index: 0, status: 'accepted' });
    expect(response.body.items[0].eventId).toBeDefined();

    // A garantia e a linha no banco, e ela existe ANTES da resposta.
    expect(events.size).toBe(1);
    expect(deliveries.rows.size).toBe(1);
  });

  it('a resposta NUNCA traz a resposta do destino', async () => {
    const response = await post({ eventos: [{ id_externo: 'E-1' }] }, { 'X-Api-Key': TOKEN });

    // O 202 significa "recebi e vou entregar", nao "entreguei". A entrega esta
    // apenas enfileirada, e a linha continua PENDING.
    expect(JSON.stringify(response.body)).not.toContain('destino.exemplo.test');
    const delivery = [...deliveries.rows.values()][0];
    expect(delivery?.status).toBe('PENDING');
    expect(queue.enqueued).toHaveLength(1);
  });

  it('reenviado -> 200 com o MESMO id do evento original', async () => {
    const corpo = { eventos: [{ id_externo: 'E-1', timestamp: '2026-09-17T08:00:00Z' }] };

    const primeira = await post(corpo, { 'X-Api-Key': TOKEN });
    const reenvio = await post(corpo, { 'X-Api-Key': TOKEN });

    expect(primeira.status).toBe(202);
    expect(reenvio.status).toBe(200);
    expect(reenvio.body.duplicates).toBe(1);
    expect(reenvio.body.items[0].status).toBe('duplicate');
    // Reenvio e comportamento normal de cliente bem-comportado, nao erro.
    expect(reenvio.body.items[0].eventId).toBe(primeira.body.items[0].eventId);

    expect(events.size).toBe(1);
    expect(deliveries.rows.size).toBe(1);
  });

  it('lote misto -> 202 com o resultado item a item', async () => {
    await post({ eventos: [{ id_externo: 'E-1' }] }, { 'X-Api-Key': TOKEN });

    const response = await post(
      { eventos: [{ id_externo: 'E-1' }, { id_externo: 'E-2' }] },
      { 'X-Api-Key': TOKEN },
    );

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(1);
    expect(response.body.duplicates).toBe(1);
    // O parceiro consegue casar cada item do array que ele mandou com o desfecho.
    expect(response.body.items).toEqual([
      expect.objectContaining({ index: 0, status: 'duplicate' }),
      expect.objectContaining({ index: 1, status: 'accepted' }),
    ]);
  });

  it('corpo que nao e JSON -> 400 com o motivo', async () => {
    const response = await request(app.getHttpServer())
      .post(ROTA)
      .set('X-Api-Key', TOKEN)
      .set('Content-Type', 'application/json')
      .send('{isto nao e json');

    // Diferente do poll: aqui quem chama pode corrigir, entao vale dizer o motivo.
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_body');
  });

  it('corpo acima de maxBodyBytes -> 413', async () => {
    const gigante = { eventos: [{ id_externo: 'E-1', lixo: 'x'.repeat(1_100_000) }] };

    const response = await post(gigante, { 'X-Api-Key': TOKEN });

    expect(response.status).toBe(413);
    expect(events.size).toBe(0);
  });

  it('metodo nao declarado -> 405', async () => {
    const response = await request(app.getHttpServer()).get(ROTA).set('X-Api-Key', TOKEN);
    expect(response.status).toBe(405);
  });

  it('path desconhecido -> 404 sem ecoar o path', async () => {
    const response = await request(app.getHttpServer())
      .post('/in/nao-existe')
      .set('X-Api-Key', TOKEN)
      .send({});

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('nao-existe');
  });

  it('o curinga de /in nao captura as rotas do proprio app', async () => {
    const health = await request(app.getHttpServer()).get('/healthz');

    // E exatamente para isto que o prefixo /in existe, e nao por estetica de URL.
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.body.endpoints).toContain(ROTA);
  });
});
