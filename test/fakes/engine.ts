import { join } from 'node:path';
import { loadGatewayConfig } from '../../src/config/load-config';
import { PipelineRunner } from '../../src/core/runner/run-pipeline';
import type { CompiledPipeline } from '../../src/core/types/pipeline';
import { FixedClock } from './clock';
import { SequentialIdGenerator } from './id-generator';
import {
  DirectUnitOfWork,
  InMemoryDeliveryStore,
  InMemoryEventStore,
  InMemoryQueue,
  InMemoryRunStore,
  StaticSecretResolver,
} from './in-memory-stores';
import { PassthroughTracing, RecordingLogger, RecordingMetrics } from './observability';

/** Segredos das FIXTURES de teste. Nenhum corresponde a credencial real. */
export const TEST_SECRETS = new StaticSecretResolver({
  ORIGEM_USUARIO: 'usuario-de-teste',
  ORIGEM_SENHA: 'senha-de-teste',
  DESTINO_A_TOKEN: 'token-do-destino-a',
  RECEPCAO_API_KEY: 'chave-da-recepcao',
  DESTINO_B_TOKEN: 'token-do-destino-b',
});

export const TEST_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/gateway',
} as NodeJS.ProcessEnv;

/**
 * Carrega FIXTURES sinteticas pelo mesmo caminho que producao
 * (YAML -> Zod -> compile), em vez de fabricar um CompiledPipeline na mao: um
 * objeto montado a mao concorda com o codigo por construcao e deixaria de pegar
 * os erros de compilacao do YAML.
 *
 * As fixtures nao sao copias de nenhum fluxo real, de proposito. Um YAML de
 * producao muda por motivo de negocio -- um status novo, outra janela de datas
 * -- e derrubaria testes de motor que nada tem a ver com aquela mudanca.
 */
export async function loadExamplePipelines(): Promise<Record<string, CompiledPipeline>> {
  const config = await loadGatewayConfig({
    dir: join(__dirname, '..', 'fixtures', 'pipelines', 'valid'),
    secrets: TEST_SECRETS,
    env: TEST_ENV,
  });
  return Object.fromEntries(config.pipelines.map((p) => [p.id, p]));
}

export interface TestEngine {
  runner: PipelineRunner;
  events: InMemoryEventStore;
  deliveries: InMemoryDeliveryStore;
  runs: InMemoryRunStore;
  queue: InMemoryQueue;
  metrics: RecordingMetrics;
  logger: RecordingLogger;
  clock: FixedClock;
}

export function buildEngine(now = new Date('2026-09-17T12:00:00.000Z')): TestEngine {
  const events = new InMemoryEventStore();
  const deliveries = new InMemoryDeliveryStore();
  const runs = new InMemoryRunStore();
  const queue = new InMemoryQueue();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const clock = new FixedClock(now);

  const runner = new PipelineRunner({
    events,
    deliveries,
    runs,
    queue,
    uow: new DirectUnitOfWork(),
    ids: new SequentialIdGenerator(),
    clock,
    logger,
    metrics,
    tracing: new PassthroughTracing(),
  });

  return { runner, events, deliveries, runs, queue, metrics, logger, clock };
}
