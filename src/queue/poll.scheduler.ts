import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { PollPipeline } from '../config/pipeline-registry';
import { PIPELINE_REGISTRY, type PipelineRegistry } from '../config/pipeline-registry';
import { HTTP_CLIENT, type HttpClient } from '../core/ports/http-client';
import { LOGGER, type Logger } from '../core/ports/logger';
import { METRICS, type Metrics } from '../core/ports/metrics';
import { PIPELINE_LOCK, type PipelineLock, SKIPPED } from '../core/ports/pipeline-lock';
import { SECRET_RESOLVER, type SecretResolver } from '../core/ports/secret-resolver';
import { TOKEN_CACHE, type TokenCache } from '../core/ports/token-cache';
import { TRACING, type Tracing } from '../core/ports/tracing';
import { alreadySafe, maskError } from '../core/redaction/mask';
import { PipelineRunner } from '../core/runner/run-pipeline';
import { HttpPollSource } from '../core/source/http-poll.source';

/**
 * Cron por pipeline, registrado no boot a partir do YAML.
 *
 * Usa o SchedulerRegistry (em memoria) e nao os job schedulers do BullMQ de
 * proposito: os do BullMQ sao persistidos em Redis, entao apagar um YAML NAO
 * pararia a coleta -- o agendamento continuaria vivo no Redis por semanas, e
 * seria preciso reconciliar explicitamente no boot. Em memoria, remover o
 * arquivo e reiniciar ja e a remocao.
 */
@Injectable()
export class PollScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(PIPELINE_REGISTRY) private readonly registry: PipelineRegistry,
    private readonly scheduler: SchedulerRegistry,
    private readonly runner: PipelineRunner,
    @Inject(PIPELINE_LOCK) private readonly locks: PipelineLock,
    @Inject(HTTP_CLIENT) private readonly http: HttpClient,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(TOKEN_CACHE) private readonly cache: TokenCache,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(TRACING) private readonly tracing: Tracing,
  ) {}

  onApplicationBootstrap(): void {
    for (const pipeline of this.registry.polls) {
      const name = `poll:${pipeline.id}`;
      const job = CronJob.from({
        cronTime: pipeline.source.schedule,
        timeZone: pipeline.source.timezone,
        onTick: () => {
          void this.collect(pipeline);
        },
      });
      this.scheduler.addCronJob(name, job);
      job.start();
      this.logger.info(
        'coleta agendada',
        alreadySafe({
          pipelineId: pipeline.id,
          schedule: pipeline.source.schedule,
          timezone: pipeline.source.timezone,
        }),
      );
    }
  }

  onApplicationShutdown(): void {
    for (const name of this.scheduler.getCronJobs().keys()) {
      if (name.startsWith('poll:')) this.scheduler.getCronJob(name).stop();
    }
  }

  async collect(pipeline: PollPipeline): Promise<void> {
    const startedAt = Date.now();

    try {
      // @Cron dispara em TODA instancia e o app escala horizontalmente. Sem o
      // lock, N replicas consultam a mesma pagina ao mesmo tempo -- o que a
      // deduplicacao absorveria, mas ao custo de N vezes mais requisicoes
      // contra a API do parceiro.
      const result = await this.locks.withLock(`collect:${pipeline.id}`, () =>
        this.tracing.withSpan(
          'gateway.collect',
          { 'gateway.pipeline.id': pipeline.id, 'gateway.source.kind': 'http-poll' },
          async (span) => {
            const source = new HttpPollSource(pipeline.source, {
              http: this.http,
              secrets: this.secrets,
              cache: this.cache,
              metrics: this.metrics,
              tracing: this.tracing,
            });
            const ingest = await this.runner.run(pipeline, source);
            span.setAttribute('gateway.collect.pages', ingest.pages);
            span.setAttribute('gateway.collect.accepted', ingest.accepted);
            return ingest;
          },
        ),
      );

      if (result === SKIPPED) {
        this.metrics.collectSkipped(1, { pipelineId: pipeline.id });
        this.logger.debug(
          'coleta ja em curso em outra instancia',
          alreadySafe({ pipelineId: pipeline.id }),
        );
        return;
      }

      this.metrics.pollDuration(Date.now() - startedAt, {
        pipelineId: pipeline.id,
        outcome: 'ok',
      });
      this.logger.info(
        'coleta concluida',
        alreadySafe({
          pipelineId: pipeline.id,
          paginas: result.pages,
          recebidos: result.received,
          filtrados: result.filteredOut,
          duplicados: result.duplicates,
          novos: result.accepted,
          entregas: result.deliveriesCreated,
        }),
      );
    } catch (error) {
      this.metrics.pollDuration(Date.now() - startedAt, {
        pipelineId: pipeline.id,
        outcome: 'error',
      });
      // A linha de pipeline_run da pagina que falhou ja foi gravada com ERROR
      // pela propria fonte, que e quem sabe qual pagina era.
      this.logger.error(
        'coleta falhou',
        maskError(error),
        alreadySafe({ pipelineId: pipeline.id }),
      );
    }
  }
}
