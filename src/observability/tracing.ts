import { Injectable } from '@nestjs/common';
import {
  type Attributes,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { SpanHandle, SpanKind, Tracing } from '../core/ports/tracing';
import { maskError } from '../core/redaction/mask';

const KINDS: Record<SpanKind, OtelSpanKind> = {
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
};

/**
 * A auto-instrumentacao cobre HTTP, Postgres e Redis, e com isso o trace diz
 * "houve query lenta". O que se precisa saber e por que um EVENTO ESPECIFICO
 * demorou -- e isso exige spans nas fronteiras de dominio: uma coleta, uma
 * pagina, uma entrega.
 */
@Injectable()
export class OtelTracing implements Tracing {
  private readonly tracer = trace.getTracer('app-api-gateway');

  async withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, string | number | boolean>>,
    fn: (span: SpanHandle) => Promise<T>,
    kind: SpanKind = 'internal',
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      name,
      { kind: KINDS[kind], attributes: attrs as Attributes },
      async (span) => {
        const handle: SpanHandle = {
          setAttribute: (key, value) => {
            span.setAttribute(key, value);
          },
        };
        try {
          const result = await fn(handle);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          // MASCARADO: recordException registra name/message/stack como
          // atributos do span, e o backend de traces e mais um lugar onde um
          // token nao pode terminar.
          const masked = maskError(error);
          span.recordException({ name: masked.name, message: masked.message, stack: masked.stack });
          span.setStatus({ code: SpanStatusCode.ERROR, message: masked.message });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  currentTraceId(): string | undefined {
    const span = trace.getActiveSpan();
    if (span === undefined) return undefined;
    const context = span.spanContext();
    return context.traceId === '00000000000000000000000000000000' ? undefined : context.traceId;
  }
}
