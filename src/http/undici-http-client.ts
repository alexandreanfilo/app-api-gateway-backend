import { Injectable } from '@nestjs/common';
import type { HttpClient, HttpOutcome, OutboundRequest } from '../core/ports/http-client';
import { materializeHeaders } from '../core/steps/auth';

const MAX_RESPONSE_CAPTURE = 64 * 1024;

function errorCode(error: unknown): string {
  const candidate = error as { name?: string; code?: string; cause?: { code?: string } };
  if (candidate?.cause?.code !== undefined) return candidate.cause.code;
  if (candidate?.code !== undefined) return candidate.code;
  if (candidate?.name === 'TimeoutError' || candidate?.name === 'AbortError') return 'ETIMEDOUT';
  return 'ENETWORK';
}

@Injectable()
export class UndiciHttpClient implements HttpClient {
  /**
   * Nunca lanca por status HTTP nem por erro de rede: devolve HttpOutcome, e
   * quem classifica e uma funcao pura testavel (core/steps/classify.ts). Se
   * este metodo lancasse, a decisao "retenta ou nao" ficaria espalhada por
   * blocos catch.
   */
  async send(request: OutboundRequest): Promise<HttpOutcome> {
    const startedAt = Date.now();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        // materializeHeaders e a ULTIMA linha antes do envio, e o unico ponto
        // do sistema onde uma credencial vira string solta.
        headers: materializeHeaders(request.headers),
        ...(request.body !== undefined ? { body: request.body } : {}),
        // 3xx nao e seguido: um redirect aqui significa URL de destino errada no
        // YAML, e segui-lo em silencio mandaria o payload para um lugar que
        // ninguem configurou -- possivelmente sem o header de autenticacao.
        redirect: 'manual',
        signal: AbortSignal.timeout(request.timeoutMs),
      });

      const raw = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        kind: 'response',
        status: response.status,
        headers,
        body: raw.length > MAX_RESPONSE_CAPTURE ? raw.slice(0, MAX_RESPONSE_CAPTURE) : raw,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        kind: 'network',
        code: errorCode(error),
        // A mensagem do undici pode ecoar a URL inteira, query string inclusa.
        // Quem for logar isto passa por maskError antes.
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
