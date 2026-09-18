/**
 * Fronteira de modulo garantida por ferramenta, nao por convencao.
 *
 * Este arquivo e o PORTAO (roda em CI e no pre-push). O Biome da o mesmo
 * feedback no editor em segundos, mas casa o especificador de import, nao o
 * caminho resolvido -- e portanto e conveniencia, nao garantia.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-sealed',
      severity: 'error',
      comment:
        'core/ e o motor: so pode depender de si mesmo, de builtins do node e de @opentelemetry/api.',
      from: { path: '^src/core/' },
      to: {
        pathNot: ['^src/core/', '^node_modules/@opentelemetry/api/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'no-client-names',
      severity: 'error',
      comment:
        'Nenhum nome de cliente, terminal ou orgao no codigo. Pipelines sao dados (YAML), nao modulos.',
      from: { path: '^src/' },
      to: {
        path: '^src/.*(gts|sao-luis|saoluis|parceiro-x|trizy|tsm|lyin|receita-federal|recintos)',
      },
    },
    {
      name: 'persistence-is-a-leaf',
      severity: 'error',
      comment: 'persistence/ e folha: implementa portas, nao orquestra camadas acima.',
      from: { path: '^src/persistence/' },
      to: { path: '^src/(http|queue|config)/' },
    },
    {
      name: 'only-logger-imports-consola',
      severity: 'error',
      comment:
        'Sem isto, o primeiro consola.error(err) num catch derrota todo o desenho de mascaramento.',
      from: { path: '^src/', pathNot: '^src/observability/logger\\.ts$' },
      to: { path: '^node_modules/consola' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '^src/instrumentation\\.ts$'] },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    // CRITICO: sem isto, `import type { X } from '../persistence/db'` some do
    // grafo (e apagado na compilacao) e a fronteira vaza justamente por tipos,
    // que e como o acoplamento sempre comeca.
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.spec\\.ts$|^src/persistence/migrations/)' },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
