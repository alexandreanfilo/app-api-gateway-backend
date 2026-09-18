import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PIPELINE_REGISTRY, type PipelineRegistry } from '../config/pipeline-registry';
import { CLOCK, type Clock } from '../core/ports/clock';
import type { DeliveryJobData } from '../core/ports/delivery-queue';
import {
  DELIVERY_STORE,
  type DeliveryOutcomeRecord,
  type DeliveryStore,
} from '../core/ports/delivery-store';
import { EVENT_STORE, type EventStore } from '../core/ports/event-store';
import { HTTP_CLIENT, type HttpClient, type HttpOutcome } from '../core/ports/http-client';
import { LOGGER, type Logger } from '../core/ports/logger';
import { METRICS, type Metrics } from '../core/ports/metrics';
import { SECRET_RESOLVER, type SecretResolver } from '../core/ports/secret-resolver';
import { TOKEN_CACHE, type TokenCache } from '../core/ports/token-cache';
import { alreadySafe } from '../core/redaction/mask';
import { buildOutboundAuthHeaders } from '../core/steps/auth';
import { computeBackoff } from '../core/steps/backoff';
import { sha256Hex } from '../core/steps/canonical';
import { classify } from '../core/steps/classify';
import { applyTransform } from '../core/steps/transform';
import type { DeliveryId } from '../core/types/ids';
import type { CompiledPipeline, DestinationSpec } from '../core/types/pipeline';
import { GATEWAY_RUNTIME, type RuntimeConfig } from '../runtime.tokens';
import { type JobEnvelope, openEnvelope } from './otel-envelope';
import { DELIVERY_QUEUE_NAME } from './queue-names';

/**
 * Lancada apenas quando o erro e genuinamente retentavel. O BullMQ le
 * `retryDelayMs` pela backoffStrategy registrada no worker, e e o MESMO valor
 * gravado em next_attempt_at -- os dois lados compartilham computeBackoff().
 */
export class RetryableDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryDelayMs: number,
  ) {
    super(message);
    this.name = 'RetryableDeliveryError';
  }
}

export class DeliveryExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryExhaustedError';
  }
}

@Processor(DELIVERY_QUEUE_NAME, {
  concurrency: Number(process.env.DELIVERY_CONCURRENCY ?? 8),
  // MAIOR que o timeout HTTP total, com folga. Um lockDuration menor fabrica
  // stalled jobs e, com eles, entrega duplicada de forma SISTEMATICA -- nao rara.
  lockDuration: 90_000,
  settings: {
    // A ponte que impede fila e banco de divergirem no tempo: o atraso vem do
    // MESMO computeBackoff() que gravou next_attempt_at no Postgres, carregado
    // no proprio erro. Sem isto, o BullMQ usaria a curva dele e o drenador a do
    // banco, e os dois brigariam pelo mesmo job.
    backoffStrategy: (_attemptsMade: number, _type?: string, err?: Error): number =>
      err instanceof RetryableDeliveryError ? err.retryDelayMs : 30_000,
  },
})
export class DeliveryProcessor extends WorkerHost {
  constructor(
    @Inject(PIPELINE_REGISTRY) private readonly registry: PipelineRegistry,
    @Inject(DELIVERY_STORE) private readonly deliveries: DeliveryStore,
    @Inject(EVENT_STORE) private readonly events: EventStore,
    @Inject(HTTP_CLIENT) private readonly http: HttpClient,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(TOKEN_CACHE) private readonly cache: TokenCache,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(GATEWAY_RUNTIME) private readonly runtime: RuntimeConfig,
  ) {
    super();
  }

  async process(job: Job<JobEnvelope<DeliveryJobData>>): Promise<void> {
    await openEnvelope(
      job.data,
      'gateway.deliver',
      {
        'messaging.system': 'bullmq',
        'messaging.message.id': job.id ?? '',
        'messaging.bullmq.attempt': job.attemptsMade,
        'gateway.pipeline.id': job.data.payload.pipelineId,
        'gateway.destination.id': job.data.payload.destinationId,
      },
      (payload) => this.deliver(payload),
    );
  }

  private async deliver(payload: DeliveryJobData): Promise<void> {
    const id = payload.deliveryId;
    const createdAt = new Date(payload.createdAt);

    const pipeline = this.registry.byIdOrUndefined(payload.pipelineId);

    // PIPELINE desconhecido nao e o mesmo que destino removido.
    //
    // Esta instancia pode simplesmente nao ter o YAML ainda -- durante um deploy
    // rolante, uma replica antiga ve uma fila que ja contem entregas de um
    // pipeline novo. Descartar aqui seria destruir o evento de outra replica com
    // base na propria ignorancia. Deixamos a linha intacta e lancamos, para que
    // o job seja retentado e alguma replica que conheca o pipeline o pegue.
    if (pipeline === undefined) {
      this.metrics.deliveryFinished(1, {
        pipelineId: payload.pipelineId,
        destinationId: payload.destinationId,
        outcome: 'retry',
        reason: 'PIPELINE_DESCONHECIDO',
      });
      this.logger.warn(
        'entrega de pipeline que esta instancia nao conhece; devolvida para nova tentativa',
        alreadySafe({ pipelineId: payload.pipelineId, destinationId: payload.destinationId }),
      );
      throw new RetryableDeliveryError(
        `pipeline '${payload.pipelineId}' nao carregado nesta instancia`,
        60_000,
      );
    }

    // Destino ausente de um pipeline CONHECIDO: foi deliberadamente removido do
    // YAML. Ai sim e terminal, e sem claim.
    const destination = pipeline.downstream.destinations.find(
      (d) => d.id === payload.destinationId,
    );
    if (destination === undefined) {
      await this.deliveries.markDiscarded(id, createdAt, null, 'DESTINATION_REMOVED');
      this.metrics.deliveryFinished(1, {
        pipelineId: payload.pipelineId,
        destinationId: payload.destinationId,
        outcome: 'dead',
        reason: 'DESTINATION_REMOVED',
      });
      return;
    }

    const leaseToken = crypto.randomUUID();
    const claimed = await this.deliveries.claim(
      id,
      createdAt,
      leaseToken,
      destination.leaseSeconds,
      this.runtime.workerId,
    );

    // Claim perdido NAO e erro: e o caso normal de duas encarnacoes do mesmo
    // job chegando ao worker. Lancar aqui faria o BullMQ retentar trabalho que
    // ja nao existe.
    if (claimed === undefined) {
      const why = await this.deliveries.classifyClaimMiss(id, createdAt);
      if (why === 'ATTEMPTS_EXHAUSTED') {
        await this.deliveries.markDiscarded(id, createdAt, null, 'ATTEMPTS_EXHAUSTED');
        this.metrics.deliveryFinished(1, {
          pipelineId: pipeline.id,
          destinationId: destination.id,
          outcome: 'dead',
          reason: 'ATTEMPTS_EXHAUSTED',
        });
        return;
      }
      this.logger.debug('claim nao obtido', alreadySafe({ deliveryId: id, reason: why }));
      return;
    }

    const body = await this.renderBody(pipeline, claimed.eventId, id, createdAt, leaseToken);
    if (body === undefined) return;

    const authHeaders = await buildOutboundAuthHeaders(destination.auth, pipeline.id, {
      secrets: this.secrets,
      http: this.http,
      cache: this.cache,
      clock: this.clock,
      metrics: this.metrics,
    });

    const outcome = await this.http.send({
      method: destination.method,
      url: destination.url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // O id da entrega vira Idempotency-Key no destino. E a unica defesa
        // contra a duplicata irredutivel: crash entre o 200 do destino e o
        // UPDATE que grava DELIVERED.
        'idempotency-key': id,
        'x-event-id': claimed.eventId,
        'x-delivery-attempt': String(claimed.attemptCount),
        ...destination.headers,
        ...authHeaders,
      },
      body,
      timeoutMs: destination.timeoutMs,
    });

    await this.recordOutcome(pipeline, destination, claimed.attemptCount, {
      id,
      createdAt,
      leaseToken,
      maxAttempts: claimed.maxAttempts,
      body,
      outcome,
    });
  }

  private async renderBody(
    pipeline: CompiledPipeline,
    eventId: string,
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
  ): Promise<string | undefined> {
    const payload = await this.events.payloadOf(eventId as never);
    if (payload === undefined) {
      await this.deliveries.markDiscarded(id, createdAt, leaseToken, 'INVALID_PAYLOAD', {
        durationMs: 0,
        errorCode: 'EVENT_NOT_FOUND',
        errorMessage: 'evento nao encontrado (purgado antes da entrega?)',
        persistBody: 'HASH_ONLY',
      });
      return undefined;
    }

    // O corpo e renderizado AGORA, nao materializado no fan-out. Consequencia
    // pratica que vale ouro: corrigir o transform no YAML conserta as
    // retentativas pendentes automaticamente, sem replay.
    const transformed = applyTransform(pipeline.downstream.transform)(payload);
    if (!transformed.ok) {
      await this.deliveries.markDiscarded(id, createdAt, leaseToken, 'INVALID_PAYLOAD', {
        durationMs: 0,
        errorCode: 'TRANSFORM_FAILED',
        errorMessage: transformed.error.detail,
        persistBody: 'HASH_ONLY',
      });
      return undefined;
    }
    return JSON.stringify(transformed.value);
  }

  private async recordOutcome(
    pipeline: CompiledPipeline,
    destination: DestinationSpec,
    attemptCount: number,
    ctx: {
      id: DeliveryId;
      createdAt: Date;
      leaseToken: string;
      maxAttempts: number;
      body: string;
      outcome: HttpOutcome;
    },
  ): Promise<void> {
    const classification = classify(ctx.outcome, destination, this.clock.now());
    const record: DeliveryOutcomeRecord = {
      ...(ctx.outcome.kind === 'response'
        ? {
            responseStatus: ctx.outcome.status,
            responseBody: ctx.outcome.body,
            responseHeaders: ctx.outcome.headers,
          }
        : { errorCode: ctx.outcome.code, errorMessage: ctx.outcome.message }),
      requestBody: ctx.body,
      requestBodyBytes: Buffer.byteLength(ctx.body, 'utf8'),
      requestBodySha256: sha256Hex(ctx.body),
      durationMs: ctx.outcome.durationMs,
      persistBody: destination.persistBody,
    };

    const attrs = {
      pipelineId: pipeline.id,
      destinationId: destination.id,
      ...(ctx.outcome.kind === 'response' ? { httpStatus: ctx.outcome.status } : {}),
    };
    this.metrics.deliveryDuration(ctx.outcome.durationMs, attrs);

    if (classification.kind === 'SUCCESS') {
      const owned = await this.deliveries.markDelivered(
        ctx.id,
        ctx.createdAt,
        ctx.leaseToken,
        record,
      );
      if (!owned) {
        // Perdemos o fencing: outra instancia tomou a linha enquanto o HTTP
        // estava em voo. Ou seja, o destino acabou de receber duas vezes.
        this.metrics.duplicateDeliveryDetected(1, attrs);
        this.logger.warn(
          'entrega duplicada detectada: o lease foi perdido durante a chamada HTTP',
          alreadySafe({ deliveryId: ctx.id, destinationId: destination.id }),
        );
      }
      this.metrics.deliveryFinished(1, { ...attrs, outcome: 'ok' });
      return;
    }

    if (classification.kind === 'NON_RETRYABLE') {
      await this.deliveries.markDiscarded(
        ctx.id,
        ctx.createdAt,
        ctx.leaseToken,
        'NON_RETRYABLE_STATUS',
        { ...record, errorCode: classification.why },
      );
      this.metrics.deliveryFinished(1, { ...attrs, outcome: 'dead', reason: classification.why });
      // RETORNA sem lancar, de proposito: o banco ja declarou terminal, e lancar
      // faria o BullMQ retentar aquilo que jamais sera retentado.
      return;
    }

    if (attemptCount >= ctx.maxAttempts) {
      await this.deliveries.markDiscarded(
        ctx.id,
        ctx.createdAt,
        ctx.leaseToken,
        'ATTEMPTS_EXHAUSTED',
        { ...record, errorCode: classification.why },
      );
      this.metrics.deliveryFinished(1, { ...attrs, outcome: 'dead', reason: 'ATTEMPTS_EXHAUSTED' });
      // Aqui SIM lanca: o job vira `failed` e permanece na fila para inspecao.
      throw new DeliveryExhaustedError(
        `entrega ${ctx.id} esgotou ${ctx.maxAttempts} tentativas (${classification.why})`,
      );
    }

    const delayMs = computeBackoff(attemptCount, destination.retry, classification.retryAfterMs);
    await this.deliveries.markFailed(ctx.id, ctx.createdAt, ctx.leaseToken, record, delayMs);
    this.metrics.deliveryFinished(1, { ...attrs, outcome: 'retry', reason: classification.why });
    throw new RetryableDeliveryError(
      `entrega ${ctx.id} falhou (${classification.why}), nova tentativa em ${delayMs}ms`,
      delayMs,
    );
  }
}
