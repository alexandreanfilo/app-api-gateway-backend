import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';

/**
 * Middlewares HTTP compartilhados entre o main.ts e os testes e2e.
 *
 * Isto e um modulo separado desde o primeiro commit por um motivo concreto: se
 * o `express.raw` nascesse dentro do bootstrap() do main.ts, o teste e2e nao o
 * teria, `req.body` chegaria vazio ou como objeto, e alguem "consertaria" o
 * controller com um fallback que mascara o bug em producao -- o teste passando
 * justamente porque exercita um caminho diferente do real.
 */
export function configureHttp(app: NestExpressApplication, globalMaxBodyBytes: number): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;

  // /in/*: BYTES CRUS, qualquer content-type.
  //
  // O hash de deduplicacao (dedupe.onMissing: generate) nao pode sair de
  // JSON.stringify(req.body): ordem de chaves, escape de unicode e normalizacao
  // de numeros fazem o hash divergir do que o parceiro realmente enviou, e duas
  // requisicoes identicas na origem produziriam chaves diferentes.
  //
  // O body-parser marca req._body = true, entao o express.json() abaixo nao
  // reprocessa o que ja foi lido aqui.
  http.use('/in', express.raw({ type: () => true, limit: globalMaxBodyBytes, inflate: true }));

  // Resto do app (health, metricas): JSON normal e limite apertado.
  http.use(express.json({ limit: '256kb' }));

  // O IP de origem vai para a auditoria; atras de load balancer, sem isto ele
  // seria sempre o do proprio balanceador.
  http.set('trust proxy', 1);
  app.enableShutdownHooks();
}
