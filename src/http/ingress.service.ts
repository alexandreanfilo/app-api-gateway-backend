import { Inject, Injectable } from '@nestjs/common';
import {
  type EndpointPipeline,
  PIPELINE_REGISTRY,
  type PipelineRegistry,
} from '../config/pipeline-registry';
import { LOGGER, type Logger } from '../core/ports/logger';
import { METRICS, type Metrics } from '../core/ports/metrics';
import { SECRET_RESOLVER, type SecretResolver } from '../core/ports/secret-resolver';
import { TRACING, type Tracing } from '../core/ports/tracing';
import { alreadySafe, maskError, maskHeaders } from '../core/redaction/mask';
import { PipelineRunner } from '../core/runner/run-pipeline';
import { HttpEndpointSource } from '../core/source/http-endpoint.source';
import { verifyInboundAuth } from '../core/steps/auth';
import { sha256Hex } from '../core/steps/canonical';
import type { IngestResult, ItemOutcome } from '../core/types/event';
import type { JsonValue } from '../core/types/json';
import { RateLimiter } from './rate-limiter';

export interface InboundHttpRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly sourceIp: string;
}

export interface IngressResponse {
  readonly status: number;
  readonly body: unknown;
}

@Injectable()
export class IngressService {
  constructor(
    @Inject(PIPELINE_REGISTRY) private readonly registry: PipelineRegistry,
    private readonly runner: PipelineRunner,
    private readonly rateLimiter: RateLimiter,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(TRACING) private readonly tracing: Tracing,
  ) {}

  async handle(request: InboundHttpRequest): Promise<IngressResponse> {
    const pipeline = this.registry.lookupByPath(request.path);
    if (pipeline === undefined) {
      this.metrics.ingressRejected(1, { reason: '404' });
      // Sem eco do path na resposta: nao devolver ao chamador aquilo que ele
      // acabou de mandar evita transformar o endpoint em espelho.
      return { status: 404, body: { error: 'unknown_endpoint' } };
    }

    return this.tracing.withSpan(
      'gateway.ingest',
      { 'gateway.pipeline.id': pipeline.id, 'gateway.source.kind': 'http-endpoint' },
      () => this.handlePipeline(pipeline, request),
      'server',
    );
  }

  private async handlePipeline(
    pipeline: EndpointPipeline,
    request: InboundHttpRequest,
  ): Promise<IngressResponse> {
    const source = pipeline.source;

    // Ordem dos checks: auth antes de tamanho e de parse, para que um chamador
    // sem credencial nao consiga nem medir o comportamento do endpoint.
    const authorized = await verifyInboundAuth(source.auth, request.headers, this.secrets).catch(
      (error: unknown) => {
        this.logger.error('falha ao verificar autenticacao de entrada', maskError(error));
        return false;
      },
    );

    if (!authorized) {
      this.metrics.ingressRejected(1, { pipelineId: pipeline.id, reason: '401' });
      // A tentativa vai para o log com pipeline e IP -- e os headers passam
      // pelo mascarador, nunca crus.
      this.logger.warn(
        'autenticacao de entrada recusada',
        alreadySafe({
          pipelineId: pipeline.id,
          sourceIp: request.sourceIp,
          headers: maskHeaders(request.headers),
        }),
      );
      return { status: 401, body: { error: 'unauthorized' } };
    }

    if (!source.methods.includes(request.method.toUpperCase())) {
      this.metrics.ingressRejected(1, { pipelineId: pipeline.id, reason: '405' });
      return { status: 405, body: { error: 'method_not_allowed', allowed: source.methods } };
    }

    if (request.body.byteLength > source.maxBodyBytes) {
      this.metrics.ingressRejected(1, { pipelineId: pipeline.id, reason: '413' });
      return {
        status: 413,
        body: { error: 'payload_too_large', maxBytes: source.maxBodyBytes },
      };
    }

    if (source.rateLimitPerMinute !== undefined) {
      const allowed = await this.rateLimiter.allow(pipeline.id, source.rateLimitPerMinute);
      if (!allowed) {
        this.metrics.ingressRejected(1, { pipelineId: pipeline.id, reason: '429' });
        return { status: 429, body: { error: 'rate_limit_exceeded' } };
      }
    }

    this.metrics.inboundBodySize(request.body.byteLength, { pipelineId: pipeline.id });

    let parsed: JsonValue;
    try {
      parsed = JSON.parse(request.body.toString('utf8')) as JsonValue;
    } catch (error) {
      this.metrics.ingressRejected(1, { pipelineId: pipeline.id, reason: '400' });
      // Diferente do poll: aqui quem chama pode corrigir, entao vale dizer o motivo.
      return {
        status: 400,
        body: {
          error: 'invalid_body',
          detail: error instanceof Error ? error.message : 'JSON invalido',
        },
      };
    }

    const result = await this.runner.run(
      pipeline,
      new HttpEndpointSource(
        {
          headers: request.headers,
          sourceIp: request.sourceIp,
          bodyBytes: request.body.byteLength,
          ...(request.headers['content-type'] !== undefined
            ? { contentType: request.headers['content-type'] }
            : {}),
          bodyHash: sha256Hex(request.body),
        },
        parsed,
      ),
    );

    return this.toResponse(result);
  }

  /**
   * 202 com o id do evento, NUNCA a resposta do destino. A requisicao termina
   * quando o evento esta gravado: quem chama recebe "recebi e vou entregar",
   * nao "entreguei".
   *
   * Em lote, o corpo traz o resultado item a item para que o parceiro consiga
   * casar cada item do array com seu eventId. 200 puro so quando TODOS os itens
   * ja existiam -- reenvio integral e comportamento de cliente bem-comportado,
   * nao erro.
   */
  private toResponse(result: IngestResult): IngressResponse {
    const items = [...result.outcomes].sort((a, b) => a.index - b.index);
    const hasRejected = result.rejected.length > 0;
    const hasAccepted = result.accepted > 0;

    const body = {
      runId: result.runId,
      received: result.received,
      accepted: result.accepted,
      duplicates: result.duplicates,
      filtered: result.filteredOut,
      rejected: result.rejected.length,
      items: items.map(toItemBody),
    };

    if (!hasAccepted && !hasRejected && result.duplicates > 0) return { status: 200, body };
    if (!hasAccepted && hasRejected) return { status: 400, body };
    return { status: 202, body };
  }
}

function toItemBody(outcome: ItemOutcome): Record<string, unknown> {
  return {
    index: outcome.index,
    status: outcome.status,
    ...(outcome.eventId !== undefined ? { eventId: outcome.eventId } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}
