/**
 * ============================================================================
 * NAO MIGRE ESTE PROJETO PARA ESM SEM LER ISTO.
 *
 * "Importar o instrumentation na primeira linha do main.ts" so funciona quando
 * a saida e CommonJS. Em ESM todos os `import` sao icados e o grafo inteiro e
 * avaliado antes do corpo do modulo: quando este arquivo roda, @nestjs/core,
 * express, pg e ioredis JA ESTAO CARREGADOS, e o monkey-patching das
 * auto-instrumentations nao acontece.
 *
 * O sintoma nao e um erro. Nao ha aviso nenhum -- apenas spans faltando, meses
 * depois, quando alguem for investigar uma latencia e descobrir que metade do
 * trace nunca existiu.
 *
 * A alternativa em ESM seria `node --import ./dist/instrumentation.js`, que
 * reintroduz exatamente o carregamento duplicado que este projeto evita. Por
 * isso tsconfig.json fixa "module": "commonjs", e isso e requisito, nao
 * preferencia. "Migrar para ESM" parece uma tarefa de arrumacao inofensiva; nao e.
 * ============================================================================
 */
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** Guarda contra carregamento duplo (import + um eventual -r/--import). */
const STARTED = Symbol.for('app-api-gateway.otel.started');
const globals = globalThis as unknown as Record<symbol, unknown>;

if (globals[STARTED] !== true) {
  globals[STARTED] = true;

  // A URL do collector vem de variavel de ambiente, com default local. O SDK le
  // OTEL_EXPORTER_OTLP_ENDPOINT sozinho -- nada de URL no construtor do
  // exporter, que e como ela acaba hardcoded e o mesmo artefato deixa de servir
  // para N deployments.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= 'http://localhost:4318';
  process.env.OTEL_SERVICE_NAME ??= 'app-api-gateway';

  if (process.env.OTEL_DIAG === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'dev',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Um span por operacao de arquivo. Em volume vira ruido caro que
        // esconde os spans que importam.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const url = request.url ?? '';
            return url === '/healthz' || url === '/readyz' || url === '/metrics';
          },
        },
      }),
    ],
  });

  sdk.start();

  const shutdown = (): void => {
    void sdk.shutdown().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
