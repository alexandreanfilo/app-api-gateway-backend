const swcTransform = [
  '@swc/jest',
  {
    jsc: {
      target: 'es2023',
      parser: { syntax: 'typescript', decorators: true },
      // Obrigatorio: sem isto o DI do Nest falha nos testes com um erro que
      // nao aponta para a causa.
      transform: { legacyDecorator: true, decoratorMetadata: true },
      keepClassNames: true,
    },
    module: { type: 'commonjs' },
  },
];

const base = {
  rootDir: '.',
  transform: { '^.+\\.ts$': swcTransform },
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
      // `*.spec.ts` tambem casa `*.e2e-spec.ts` e `*.int-spec.ts`: sem excluir,
      // o projeto unit arrastaria junto os testes que exigem infra.
      // `*.spec.ts` casa tambem `*.e2e-spec.ts`, `*.int-spec.ts` e
      // `*.config-spec.ts`. O projeto `unit` so pode conter teste de MOTOR,
      // sobre fixtures sinteticas: se ele arrastar um teste que le o
      // `pipelines/` real, uma mudanca de negocio (um status novo, outra janela
      // de datas) passa a quebrar testes que nada tem a ver com ela.
      testPathIgnorePatterns: ['\\.e2e-spec\\.ts$', '\\.int-spec\\.ts$', '\\.config-spec\\.ts$'],
    },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      testTimeout: 30_000,
    },
    {
      ...base,
      // Valida a CONFIGURACAO de producao (`pipelines/`), nao o motor. Fica
      // separado do `unit` de proposito: e o unico lugar que deve depender dos
      // YAML reais, e e deliberado que ele quebre quando um fluxo real muda.
      displayName: 'config',
      testMatch: ['<rootDir>/test/**/*.config-spec.ts'],
    },
    {
      ...base,
      displayName: 'int',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      globalSetup: '<rootDir>/test/containers/global-setup.ts',
      globalTeardown: '<rootDir>/test/containers/global-teardown.ts',
      testTimeout: 180_000,
    },
  ],
};
