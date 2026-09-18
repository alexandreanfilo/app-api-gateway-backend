export const TRACING = Symbol('Tracing');

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
}

/**
 * A auto-instrumentacao cobre HTTP, Postgres e Redis. Estes spans existem para
 * as fronteiras de DOMINIO -- uma coleta, uma pagina, uma entrega -- sem as
 * quais o trace diz "houve query lenta" quando o que se precisa saber e por que
 * um evento especifico demorou.
 */
export interface Tracing {
  withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, string | number | boolean>>,
    fn: (span: SpanHandle) => Promise<T>,
    kind?: SpanKind,
  ): Promise<T>;
  currentTraceId(): string | undefined;
}
