import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { maskError } from '../core/redaction/mask';

/**
 * A auto-instrumentacao do ioredis cria spans dos COMANDOS Redis e da a falsa
 * impressao de que a propagacao ja funciona. Ela nao liga produtor a consumidor:
 * sem inject/extract manual, o trace quebra na fronteira da fila e o span da
 * entrega vira uma arvore orfa.
 *
 * O envelope e a unica forma de enfileirar neste projeto, entao nao da para
 * esquecer de propagar.
 */
export interface JobEnvelope<T> {
  readonly otel: Record<string, string>;
  readonly payload: T;
}

export function seal<T>(payload: T): JobEnvelope<T> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { otel: carrier, payload };
}

export async function openEnvelope<T, R>(
  envelope: JobEnvelope<T>,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (payload: T) => Promise<R>,
): Promise<R> {
  const parent = propagation.extract(ROOT_CONTEXT, envelope.otel ?? {});
  const tracer = trace.getTracer('app-api-gateway');

  return context.with(parent, () =>
    tracer.startActiveSpan(name, { kind: SpanKind.CONSUMER, attributes }, async (span) => {
      try {
        return await fn(envelope.payload);
      } catch (error) {
        const masked = maskError(error);
        span.recordException({ name: masked.name, message: masked.message, stack: masked.stack });
        span.setStatus({ code: SpanStatusCode.ERROR, message: masked.message });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
