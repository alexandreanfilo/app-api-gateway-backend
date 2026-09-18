import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import type { Pool } from 'pg';
import type { GatewayConfig } from './config/load-config';
import { PIPELINE_REGISTRY, PipelineRegistry } from './config/pipeline-registry';
import { CLOCK, systemClock } from './core/ports/clock';
import { DELIVERY_QUEUE } from './core/ports/delivery-queue';
import { DELIVERY_STORE } from './core/ports/delivery-store';
import { EVENT_STORE } from './core/ports/event-store';
import { HTTP_CLIENT } from './core/ports/http-client';
import { ID_GENERATOR } from './core/ports/id-generator';
import { LOGGER } from './core/ports/logger';
import { METRICS } from './core/ports/metrics';
import { PIPELINE_LOCK } from './core/ports/pipeline-lock';
import { RUN_STORE } from './core/ports/run-store';
import { SECRET_RESOLVER, type SecretResolver } from './core/ports/secret-resolver';
import { TOKEN_CACHE } from './core/ports/token-cache';
import { TRACING } from './core/ports/tracing';
import { UNIT_OF_WORK } from './core/ports/unit-of-work';
import { type EnginePorts, PipelineRunner } from './core/runner/run-pipeline';
import { HealthController } from './http/health.controller';
import { IngressController } from './http/ingress.controller';
import { IngressService } from './http/ingress.service';
import { RateLimiter } from './http/rate-limiter';
import { UndiciHttpClient } from './http/undici-http-client';
import { AppLogger } from './observability/logger';
import { OtelMetrics } from './observability/metrics';
import { OtelTracing } from './observability/tracing';
import { AdvisoryLockService } from './persistence/advisory-lock.service';
import { createDb, createPool, DATABASE, DATABASE_POOL } from './persistence/database';
import { PartitionService } from './persistence/partitions/partition.service';
import { PERSISTENCE_OPTIONS } from './persistence/persistence.tokens';
import { PipelineDeliveryRepository } from './persistence/repositories/pipeline-delivery.repository';
import { PipelineEventRepository } from './persistence/repositories/pipeline-event.repository';
import { PipelineRunRepository } from './persistence/repositories/pipeline-run.repository';
import { KyselyUnitOfWork } from './persistence/unit-of-work';
import { UuidGenerator } from './persistence/uuid';
import { DeliveryDrainer } from './queue/delivery.drainer';
import { DeliveryProcessor } from './queue/delivery.processor';
import { BullDeliveryQueue } from './queue/delivery-queue.adapter';
import { PollScheduler } from './queue/poll.scheduler';
import { DELIVERY_QUEUE_NAME } from './queue/queue-names';
import { RedisTokenCache } from './queue/redis-token-cache';
import { redisProvider } from './redis.provider';
import { GATEWAY_CONFIG, GATEWAY_RUNTIME } from './runtime.tokens';

/**
 * A configuracao ja chega pronta, validada e congelada: quem a carrega e o
 * main.ts, ANTES de NestFactory.create().
 *
 * Isso nao e estilo. Validar dentro de um useFactory faz o Nest embrulhar a
 * excecao em erro de DI, e a mensagem util -- "gts.yaml: source.auth.password:
 * esperado { secret: REF }" -- vira a quarta linha de um stack trace. Pior:
 * quando a validacao falha em onModuleInit, o pool do Postgres e o Redis JA
 * abriram sockets, o event loop fica vivo, e o container aparece saudavel para
 * o orquestrador enquanto nao processa nada.
 *
 * De quebra, o registry de rotas vira useValue (sem janela de corrida com o
 * roteador) e os nomes de fila ficam conhecidos em tempo de definicao de modulo,
 * que e o que BullModule.registerQueue exige.
 */
@Module({})
export class AppModule {
  static register(config: GatewayConfig, secrets: SecretResolver): DynamicModule {
    const registry = new PipelineRegistry(config.pipelines);

    const infrastructure: Provider[] = [
      { provide: GATEWAY_CONFIG, useValue: config },
      { provide: GATEWAY_RUNTIME, useValue: config.runtime },
      { provide: PIPELINE_REGISTRY, useValue: registry },
      { provide: SECRET_RESOLVER, useValue: secrets },
      { provide: CLOCK, useValue: systemClock },
      { provide: ID_GENERATOR, useClass: UuidGenerator },
      { provide: LOGGER, useFactory: () => new AppLogger('gateway') },
      { provide: METRICS, useClass: OtelMetrics },
      { provide: TRACING, useClass: OtelTracing },
      { provide: HTTP_CLIENT, useClass: UndiciHttpClient },
      { provide: TOKEN_CACHE, useClass: RedisTokenCache },
      redisProvider,
      {
        provide: DATABASE_POOL,
        useFactory: () => createPool({ connectionString: config.runtime.databaseUrl }),
      },
      { provide: DATABASE, inject: [DATABASE_POOL], useFactory: (pool: Pool) => createDb(pool) },
      {
        provide: PERSISTENCE_OPTIONS,
        useValue: { partitionMonthsAhead: config.runtime.partitionMonthsAhead },
      },
    ];

    // Adaptadores das portas. O core conhece os simbolos; quem os implementa
    // so e decidido aqui, no unico ponto que conhece os dois lados.
    const adapters: Provider[] = [
      { provide: EVENT_STORE, useClass: PipelineEventRepository },
      { provide: RUN_STORE, useClass: PipelineRunRepository },
      { provide: DELIVERY_STORE, useClass: PipelineDeliveryRepository },
      { provide: DELIVERY_QUEUE, useClass: BullDeliveryQueue },
      { provide: UNIT_OF_WORK, useClass: KyselyUnitOfWork },
      { provide: PIPELINE_LOCK, useClass: AdvisoryLockService },
    ];

    const engine: Provider = {
      provide: PipelineRunner,
      inject: [
        EVENT_STORE,
        DELIVERY_STORE,
        RUN_STORE,
        DELIVERY_QUEUE,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
        LOGGER,
        METRICS,
        TRACING,
      ],
      useFactory: (
        events: EnginePorts['events'],
        deliveries: EnginePorts['deliveries'],
        runs: EnginePorts['runs'],
        queue: EnginePorts['queue'],
        uow: EnginePorts['uow'],
        ids: EnginePorts['ids'],
        clock: EnginePorts['clock'],
        logger: EnginePorts['logger'],
        metrics: EnginePorts['metrics'],
        tracing: EnginePorts['tracing'],
      ) =>
        // `new`, e nao @Injectable() no PipelineRunner: uma classe do core com
        // decorator do Nest importaria @nestjs/common para dentro de core/, e a
        // fronteira que o dependency-cruiser protege cairia na primeira linha.
        new PipelineRunner({
          events,
          deliveries,
          runs,
          queue,
          uow,
          ids,
          clock,
          logger,
          metrics,
          tracing,
        }),
    };

    return {
      module: AppModule,
      imports: [
        ScheduleModule.forRoot(),
        BullModule.forRoot({
          connection: {
            host: config.runtime.redis.host,
            port: config.runtime.redis.port,
            db: config.runtime.redis.db,
          },
        }),
        BullModule.registerQueue({ name: DELIVERY_QUEUE_NAME }),
      ],
      controllers: [IngressController, HealthController],
      providers: [
        ...infrastructure,
        ...adapters,
        engine,
        IngressService,
        RateLimiter,
        PartitionService,
        DeliveryDrainer,
        DeliveryProcessor,
        PollScheduler,
        PipelineEventRepository,
        PipelineRunRepository,
        PipelineDeliveryRepository,
      ],
    };
  }
}
