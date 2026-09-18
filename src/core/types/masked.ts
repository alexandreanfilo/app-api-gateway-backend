declare const MASKED: unique symbol;

/**
 * Tipo de marca. A porta de log e a de auditoria so aceitam Masked<...>, entao
 * passar `req.headers` cru NAO COMPILA.
 *
 * Isto converte "lembre-se de mascarar" -- convencao que falha na primeira
 * pressa -- em erro de tipo. Quem produz valores Masked e exclusivamente
 * observability/mask.ts.
 */
export type Masked<T> = T & { readonly [MASKED]: true };

export interface LoggableError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly cause?: LoggableError;
  readonly http?: {
    readonly status: number;
    readonly url: string;
    readonly responseSnippet?: string;
  };
}
