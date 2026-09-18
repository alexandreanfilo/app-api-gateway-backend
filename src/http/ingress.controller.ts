import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IngressService } from './ingress.service';

/**
 * UM controller para todos os pipelines de entrada. Nao existe controller por
 * cliente, e nao ha geracao dinamica de classes.
 *
 * Gerar uma classe por pipeline funciona, mas duplicaria por classe a leitura
 * do corpo cru, a autenticacao, o limite de tamanho e o tratamento de erro --
 * exatamente o erro de desenho que o projeto proibe a jusante, so que na camada
 * HTTP.
 */
@Controller('in')
export class IngressController {
  constructor(private readonly ingress: IngressService) {}

  /**
   * Express 5 (path-to-regexp 8): `@All('*')` LANCA no boot com
   * "Missing parameter name". O curinga precisa ser nomeado.
   */
  @All('*path')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const outcome = await this.ingress.handle({
      // req.path, e NAO req.params.path: com curinga nomeado o Express 5 entrega
      // params.path como ARRAY de segmentos, e quem fizer .split('/') nele leva
      // um TypeError em producao. req.path ja vem sem a query string.
      path: request.path,
      method: request.method,
      headers: normalizeHeaders(request.headers),
      body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      sourceIp: request.ip ?? request.socket.remoteAddress ?? 'desconhecido',
    });

    response.status(outcome.status).json(outcome.body);
  }
}

function normalizeHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
