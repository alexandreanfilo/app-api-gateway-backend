import type { HttpClient } from '../ports/http-client';
import type { Metrics } from '../ports/metrics';
import type { SecretResolver } from '../ports/secret-resolver';
import type { TokenCache } from '../ports/token-cache';
import type { Tracing } from '../ports/tracing';
import { maskError, maskUrl } from '../redaction/mask';
import { type AuthPorts, buildOutboundAuthHeaders } from '../steps/auth';
import { resolveQueryPlaceholders } from '../steps/date-placeholders';
import { getPath } from '../steps/path';
import { splitBody } from '../steps/split';
import type { RawBatch } from '../types/event';
import { isJsonObject, type JsonObject, type JsonValue } from '../types/json';
import type { CompiledPollSource } from '../types/pipeline';
import type { CollectContext, Source } from './source';

export class PollError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PollError';
  }
}

export interface PollPorts {
  readonly http: HttpClient;
  readonly secrets: SecretResolver;
  readonly cache: TokenCache;
  readonly metrics: Metrics;
  readonly tracing: Tracing;
}

/**
 * Polling Consumer. Rende uma linha de auditoria e um lote POR PAGINA: se a
 * pagina 7 de 10 falhar, as seis primeiras ja estao gravadas e deduplicadas, e
 * o proximo ciclo do cron retoma sem reprocessar o que entrou.
 */
export class HttpPollSource implements Source {
  constructor(
    private readonly spec: CompiledPollSource,
    private readonly ports: PollPorts,
  ) {}

  async *collect(ctx: CollectContext): AsyncIterable<RawBatch> {
    const pipelineId = ctx.pipeline.id;
    const now = ctx.clock.now();
    const query = resolveQueryPlaceholders(this.spec.query, now, this.spec.timezone);

    const authHeaders = await buildOutboundAuthHeaders(this.spec.auth, pipelineId, {
      secrets: this.ports.secrets,
      http: this.ports.http,
      cache: this.ports.cache,
      clock: ctx.clock,
      metrics: this.ports.metrics,
    } satisfies AuthPorts);

    const pagination = this.spec.pagination;
    const firstPage = pagination?.start ?? 1;
    const maxPages = pagination?.maxPages ?? 1;

    let collected = 0;
    let totalRecordCount: number | undefined;

    for (let page = firstPage; page < firstPage + maxPages; page++) {
      const url = this.buildUrl(
        query,
        pagination === undefined ? undefined : { param: pagination.param, page },
      );
      const startedAt = Date.now();

      const run = await ctx.beginRun({
        trigger: 'POLL',
        requestUrl: maskUrl(url),
        requestPage: page,
      });

      const outcome = await this.ports.tracing.withSpan(
        'gateway.page',
        { 'gateway.pipeline.id': pipelineId, 'gateway.poll.page': page },
        async (span) => {
          const result = await this.ports.http.send({
            method: this.spec.method,
            url,
            headers: { ...this.spec.headers, ...authHeaders, accept: 'application/json' },
            timeoutMs: this.spec.timeoutMs,
          });
          if (result.kind === 'response')
            span.setAttribute('http.response.status_code', result.status);
          return result;
        },
        'client',
      );

      if (outcome.kind === 'network') {
        const error = new PollError(`falha de rede ao coletar pagina ${page}`, outcome.code);
        await ctx.failRun(run, maskError(error), Date.now() - startedAt);
        throw error;
      }
      if (outcome.status < 200 || outcome.status >= 300) {
        const error = new PollError(
          `pagina ${page} respondeu HTTP ${outcome.status}`,
          `HTTP_${outcome.status}`,
        );
        await ctx.failRun(run, maskError(error), Date.now() - startedAt);
        throw error;
      }

      let parsed: JsonValue;
      try {
        parsed = JSON.parse(outcome.body) as JsonValue;
      } catch {
        const error = new PollError(`pagina ${page} nao devolveu JSON`, 'INVALID_JSON');
        await ctx.failRun(run, maskError(error), Date.now() - startedAt);
        throw error;
      }

      if (this.spec.totalCountPath !== undefined && totalRecordCount === undefined) {
        const raw = getPath(parsed, this.spec.totalCountPath);
        if (typeof raw === 'number') totalRecordCount = raw;
      }

      const document: JsonObject = isJsonObject(parsed) ? parsed : { value: parsed };
      const pageItems = splitBody(this.spec.itemsPath, document);
      const pageItemCount = pageItems.ok ? pageItems.value.length : 0;
      collected += pageItemCount;

      this.ports.metrics.pollPageItems(pageItemCount, { pipelineId, sourceKind: 'http-poll' });

      yield {
        items: [
          {
            data: document,
            receivedAt: ctx.clock.now(),
            index: 0,
            origin: { kind: 'poll', runId: run.id, page, requestUrl: maskUrl(url) },
          },
        ],
        bodyHash: '',
        run,
        page,
        httpStatus: outcome.status,
        requestUrl: maskUrl(url),
        ...(totalRecordCount !== undefined ? { totalRecordCount } : {}),
      };

      // Tres condicoes de parada, e todas necessarias: pagina vazia cobre a API
      // que nao declara total; o total declarado evita a requisicao inutil que
      // confirma o fim; e maxPages e o teto duro contra uma API que sempre
      // devolve a mesma pagina -- sem ele, um bug do parceiro vira laco infinito.
      if (pagination === undefined) break;
      if (pageItemCount === 0) break;
      if (totalRecordCount !== undefined && collected >= totalRecordCount) break;
    }
  }

  private buildUrl(
    query: Readonly<Record<string, string>>,
    pageParam: { param: string; page: number } | undefined,
  ): string {
    const url = new URL(this.spec.url);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (pageParam !== undefined) url.searchParams.set(pageParam.param, String(pageParam.page));
    return url.toString();
  }
}
