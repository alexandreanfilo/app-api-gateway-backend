/**
 * Compila os YAML de `pipelines/` pelo MESMO caminho que o boot usa, e imprime
 * o que o motor entendeu.
 *
 * Existe porque nada mais no projeto valida esses arquivos de forma barata:
 * `npm run check` nao le YAML, os testes unitarios usam fixtures proprias, e
 * subir o app exige Postgres e Redis. Sem isto, o primeiro sinal de que um
 * `itemsPath` esta errado seria o app nao subir em producao -- ou, pior, subir
 * e nao coletar nada.
 *
 * Os segredos NAO precisam existir: o resolvedor daqui apenas registra os nomes
 * pedidos e depois informa quais faltam no ambiente. Assim da para validar a
 * forma do YAML antes de provisionar credencial nenhuma.
 *
 * Uso, a partir da raiz do repositorio:
 *   npx tsx .claude/skills/criar-fluxo-integracao/scripts/validar-pipelines.ts
 *   npx tsx .../validar-pipelines.ts <raiz-do-repo> <diretorio-de-pipelines>
 */
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const dir = process.argv[3] ?? join(root, 'pipelines');

const pedidos = new Set<string>();

/** Diz que todo segredo existe, mas anota quais foram pedidos. */
const resolvedorStub = {
  async exists(nome: string): Promise<boolean> {
    pedidos.add(nome);
    return true;
  },
  async resolve(nome: string): Promise<never> {
    throw new Error(`validacao nao materializa segredo (${nome})`);
  },
  invalidate(): void {},
  describe(): string {
    return 'validacao (segredos nao verificados)';
  },
};

function carregar(caminho: string): Record<string, unknown> {
  // require de .ts funciona sob tsx; o caminho e absoluto para a skill poder
  // rodar de qualquer profundidade dentro do repositorio.
  return require(join(root, caminho)) as Record<string, unknown>;
}

type Pipeline = {
  id: string;
  name: string;
  client: string;
  sourceFile: string;
  source: Record<string, unknown> & { kind: string };
  downstream: Record<string, unknown> & {
    filter: { rules: unknown[] };
    split: { itemsPath?: string };
    dedupe: Record<string, unknown>;
    transform: { rules: [string, unknown][] };
    destinations: { id: string; url: string; filter: { rules: unknown[] } }[];
  };
};

async function main(): Promise<void> {
  const { loadGatewayConfig } = carregar('src/config/load-config') as {
    loadGatewayConfig: (o: unknown) => Promise<{ pipelines: Pipeline[]; warnings: string[] }>;
  };
  const { ConfigError, formatConfigError } = carregar('src/config/config-error') as {
    ConfigError: new (...args: never[]) => Error;
    formatConfigError: (e: Error) => string;
  };

  let config: { pipelines: Pipeline[]; warnings: string[] };
  try {
    config = await loadGatewayConfig({
      dir,
      secrets: resolvedorStub,
      // DATABASE_URL e obrigatoria para a config de runtime, mas nao tem relacao
      // nenhuma com a validade do YAML.
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://x:x@localhost:5432/x' },
    });
  } catch (erro) {
    if (erro instanceof ConfigError) {
      console.error(formatConfigError(erro));
      process.exit(1);
    }
    throw erro;
  }

  console.log(`${config.pipelines.length} pipeline(s) habilitado(s) em ${dir}\n`);

  for (const p of config.pipelines) {
    const d = p.downstream;
    console.log(`── ${p.id}  (${p.sourceFile})`);
    console.log(`   cliente    : ${p.client}`);
    console.log(`   entrada    : ${p.source.kind}`);
    if (p.source.kind === 'http-poll') {
      console.log(`   url        : ${String(p.source.url)}`);
      console.log(`   schedule   : ${String(p.source.schedule)}  [${String(p.source.timezone)}]`);
      console.log(`   query      : ${JSON.stringify(p.source.query)}`);
      console.log(`   paginacao  : ${JSON.stringify(p.source.pagination ?? 'sem paginacao')}`);
      console.log(`   totalCount : ${String(p.source.totalCountPath ?? '-')}`);
    } else {
      console.log(`   rota       : ${String(p.source.routePath)}  metodos=${JSON.stringify(p.source.methods)}`);
      console.log(`   maxBody    : ${String(p.source.maxBodyBytes)} bytes`);
      console.log(`   rateLimit  : ${String(p.source.rateLimitPerMinute ?? '-')}/min`);
    }
    console.log(`   itemsPath  : ${d.split.itemsPath ?? '(corpo inteiro e um item)'}`);
    console.log(`   filtro     : ${JSON.stringify(d.filter.rules)}`);
    console.log(`   dedupe     : ${JSON.stringify(d.dedupe)}`);
    console.log(`   transform  : ${JSON.stringify(d.transform.rules)}`);
    for (const dest of d.destinations) {
      const condicional = dest.filter.rules.length > 0 ? `  filtro=${JSON.stringify(dest.filter.rules)}` : '';
      console.log(`   destino    : ${dest.id} -> ${dest.url}${condicional}`);
    }
    console.log('');
  }

  if (config.warnings.length > 0) {
    console.log('AVISOS (o app sobe, mas confira):');
    for (const aviso of config.warnings) console.log(`  ! ${aviso}`);
    console.log('');
  }

  const nomes = [...pedidos].sort();
  console.log(`segredos referenciados (${nomes.length}):`);
  const faltando: string[] = [];
  for (const nome of nomes) {
    const presente = typeof process.env[nome] === 'string' && process.env[nome] !== '';
    if (!presente) faltando.push(nome);
    console.log(`  ${presente ? 'no ambiente' : 'FALTA     '}  ${nome}`);
  }

  if (faltando.length > 0) {
    console.log(
      `\nOs ${faltando.length} marcados como FALTA precisam existir no ambiente de destino,` +
        ' senao o boot recusa subir (e essa recusa e proposital).',
    );
  }
}

void main();
