import type { RawBatch } from '../types/event';
import type { JsonObject, JsonValue } from '../types/json';
import { isJsonObject } from '../types/json';
import type { CollectContext, Source } from './source';

export interface InboundRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly sourceIp: string;
  readonly bodyBytes: number;
  readonly contentType?: string;
  readonly bodyHash: string;
}

/**
 * Adaptador trivial de uma requisicao para o mesmo formato que o poll produz.
 * Toda a inteligencia (split, filtro, dedupe, transform, entrega) esta a
 * jusante e e compartilhada -- e isto aqui e curto justamente por isso.
 */
export class HttpEndpointSource implements Source {
  constructor(
    private readonly request: InboundRequest,
    private readonly body: JsonValue,
  ) {}

  async *collect(ctx: CollectContext): AsyncIterable<RawBatch> {
    const run = await ctx.beginRun({
      trigger: 'ENDPOINT',
      sourceIp: this.request.sourceIp,
      bodyBytes: this.request.bodyBytes,
      ...(this.request.contentType !== undefined ? { contentType: this.request.contentType } : {}),
    });

    const document: JsonObject = isJsonObject(this.body) ? this.body : { value: this.body };

    yield {
      items: [
        {
          data: document,
          receivedAt: ctx.clock.now(),
          index: 0,
          origin: {
            kind: 'endpoint',
            runId: run.id,
            headers: this.request.headers,
            sourceIp: this.request.sourceIp,
            bodyBytes: this.request.bodyBytes,
          },
        },
      ],
      bodyHash: this.request.bodyHash,
      run,
      page: 1,
    };
  }
}
