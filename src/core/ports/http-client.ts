import type { MaybeSecret } from '../types/secret';

export const HTTP_CLIENT = Symbol('HttpClient');

export interface OutboundRequest {
  readonly method: string;
  readonly url: string;
  /** Pode conter Secret: a materializacao acontece na ultima linha do adaptador. */
  readonly headers: Readonly<Record<string, MaybeSecret>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly kind: 'response';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
}

export interface HttpNetworkError {
  readonly kind: 'network';
  readonly code: string;
  readonly message: string;
  readonly durationMs: number;
}

export type HttpOutcome = HttpResponse | HttpNetworkError;

export interface HttpClient {
  /** Nunca lanca por status HTTP nem por erro de rede: devolve HttpOutcome. */
  send(req: OutboundRequest): Promise<HttpOutcome>;
}
