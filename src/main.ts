// PRIMEIRA LINHA. Nada antes, nem import de tipo -- ver o comentario no topo
// de instrumentation.ts para o porque de isto exigir CommonJS.
import './instrumentation';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { bootstrapConfig } from './bootstrap-config';
import { configureHttp } from './bootstrap-http';
import { ConfigError, formatConfigError } from './config/config-error';
import { alreadySafe, maskError } from './core/redaction/mask';
import { logger } from './observability/logger';

async function bootstrap(): Promise<void> {
  // FASE 1 -- sem Nest, sem sockets. Qualquer falha aqui e de CONFIGURACAO.
  const { config, secrets } = await bootstrapConfig();

  // FASE 2 -- Nest. Daqui para a frente, falha e de infraestrutura.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, secrets),
    // bodyParser desligado: /in/* precisa dos BYTES CRUS para o hash de
    // deduplicacao. Ver bootstrap-http.ts.
    { bodyParser: false, abortOnError: false, bufferLogs: true },
  );

  app.useLogger(logger);
  configureHttp(app, config.runtime.globalMaxBodyBytes);

  for (const warning of config.warnings) {
    logger.warn(`configuracao suspeita: ${warning}`, alreadySafe({}));
  }

  await app.listen(config.runtime.port, '0.0.0.0');

  logger.info(
    `gateway no ar em :${config.runtime.port}`,
    alreadySafe({
      pipelines: config.pipelines.length,
      endpoints: config.pipelines.filter((p) => p.source.kind === 'http-endpoint').length,
      polls: config.pipelines.filter((p) => p.source.kind === 'http-poll').length,
    }),
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // stderr limpo, sem stack: quem le isto quer saber qual campo de qual
    // arquivo esta errado, nao a pilha de chamadas do carregador.
    process.stderr.write(`${formatConfigError(error)}\n`);
    process.exit(1);
  }
  logger.fatal('falha no boot', maskError(error));
  // exit, e nao throw: o pool do Postgres e o Redis seguram o event loop, e um
  // throw deixaria o processo vivo sem servir nada -- saudavel para o
  // orquestrador, inutil na pratica.
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal('promise rejeitada sem tratamento', maskError(reason));
  process.exit(1);
});
