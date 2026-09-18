import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SecretResolver } from '../core/ports/secret-resolver';
import type { CompiledPipeline } from '../core/types/pipeline';
import { collectSecretRefs, compilePipeline, normalizeRoutePath } from './compile-pipeline';
import { ConfigError, type ConfigIssue, toIssues } from './config-error';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config';
import { type PipelineConfig, PipelineSchema } from './schema/pipeline.schema';

export interface GatewayConfig {
  readonly pipelines: readonly CompiledPipeline[];
  readonly runtime: RuntimeConfig;
  /**
   * Coisas suspeitas que NAO impedem o boot. Erro derruba; aviso e registrado
   * no log de inicializacao para alguem olhar.
   */
  readonly warnings: readonly string[];
}

export interface LoadOptions {
  readonly dir: string;
  readonly secrets: SecretResolver;
  readonly env?: NodeJS.ProcessEnv;
  /** Desligado nos testes de unidade, que nao tem os segredos reais no ambiente. */
  readonly checkSecrets?: boolean;
}

function yamlMessage(error: unknown): string {
  if (error instanceof Error) {
    const withPos = error as Error & { linePos?: { line: number; col: number }[] };
    const pos = withPos.linePos?.[0];
    return pos === undefined
      ? `YAML invalido: ${error.message}`
      : `YAML invalido na linha ${pos.line}, coluna ${pos.col}: ${error.message}`;
  }
  return 'YAML invalido';
}

/**
 * Quatro passes, AGREGANDO os erros em vez de parar no primeiro.
 *
 * Custa umas 40 linhas a mais e economiza seis ciclos de deploy para quem esta
 * ajustando um YAML novo: o operador ve os seis erros de uma vez, corrige, e
 * sobe. Falhar no primeiro erro transforma isso em seis idas e voltas.
 */
export async function loadGatewayConfig(options: LoadOptions): Promise<GatewayConfig> {
  const env = options.env ?? process.env;
  const issues: ConfigIssue[] = [];
  const parsed: { config: PipelineConfig; file: string }[] = [];

  let files: string[];
  try {
    files = (await readdir(options.dir)).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    throw ConfigError.single(options.dir, '', 'diretorio de pipelines nao pode ser lido');
  }
  if (files.length === 0) {
    throw ConfigError.single(options.dir, '', 'nenhum arquivo .yaml encontrado');
  }

  // ---- Passe 1 e 2: sintaxe YAML e schema Zod, arquivo a arquivo -----------
  for (const file of files) {
    let document: unknown;
    try {
      document = parseYaml(await readFile(join(options.dir, file), 'utf8'));
    } catch (error) {
      issues.push({ file, path: '', message: yamlMessage(error) });
      continue;
    }

    const result = PipelineSchema.safeParse(document);
    if (!result.success) {
      issues.push(...toIssues(file, result.error));
      continue;
    }
    parsed.push({ config: result.data, file });
  }

  // A partir daqui, so o que REALMENTE VAI RODAR.
  //
  // `enabled: false` precisa tornar o arquivo inerte. Checar segredo de pipeline
  // desabilitado inverte o sentido do campo: quando o contrato de um cliente
  // termina e o token sai do ambiente, desabilitar seria a forma de parar o
  // fluxo -- e em vez disso o gateway inteiro deixa de subir, derrubando todos
  // os outros clientes junto.
  //
  // O schema (passe 2) continua valendo para TODOS os arquivos: um YAML em
  // PIPELINES_DIR precisa ser bem formado, e isso e propriedade do artefato.
  // Segredo e colisao de rota dependem do AMBIENTE e da convivencia, e so
  // importam para quem esta no ar.
  const active = parsed.filter(({ config }) => config.enabled);

  // ---- Passe 3: invariantes que o Zod nao enxerga (sao cross-file) ---------
  const seenIds = new Map<string, string>();
  const seenPaths = new Map<string, string>();
  for (const { config, file } of active) {
    const previousFile = seenIds.get(config.id);
    if (previousFile !== undefined) {
      issues.push({
        file,
        path: 'id',
        message: `id '${config.id}' ja declarado em ${previousFile}`,
      });
    }
    seenIds.set(config.id, file);

    if (config.source.kind !== 'http-endpoint') continue;
    const routePath = normalizeRoutePath(config.source.path);
    const clash = seenPaths.get(routePath);
    if (clash !== undefined) {
      issues.push({
        file,
        path: 'source.path',
        message: `path '${routePath}' ja declarado em ${clash}`,
      });
    }
    seenPaths.set(routePath, file);
  }

  // ---- Passe 4: existencia de TODO segredo referenciado --------------------
  // Apenas existencia: o valor nao e materializado aqui. Resolver tudo no boot
  // encheria o heap de credenciais em texto puro por horas; nao checar nada
  // faria o pipeline quebrar as 2h da manha em vez de no deploy.
  if (options.checkSecrets !== false) {
    for (const { config, file } of active) {
      for (const ref of collectSecretRefs(config)) {
        if (!(await options.secrets.exists(ref.name))) {
          issues.push({
            file,
            path: ref.path,
            message: `segredo '${ref.name}' nao encontrado em ${options.secrets.describe()}`,
          });
        }
      }
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const pipelines = active.map(({ config, file }) => compilePipeline(config, file));

  return Object.freeze({
    pipelines,
    runtime: loadRuntimeConfig(env),
    warnings: collectWarnings(pipelines),
  });
}

/**
 * Dois pipelines de poll que consultam a MESMA origem e entregam no MESMO
 * destino coletam tudo em dobro e entregam cada evento duas vezes -- com ids de
 * entrega distintos, entao nem o Idempotency-Key do destino protege.
 *
 * Nao e erro de boot porque ha caso legitimo: mesma origem, filtros diferentes,
 * destinos diferentes. Mas quando a origem E o destino coincidem, quase sempre e
 * um arquivo esquecido, e sem aviso isso so aparece como cobranca em duplicidade
 * do outro lado.
 */
function collectWarnings(pipelines: readonly CompiledPipeline[]): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, string>();

  for (const pipeline of pipelines) {
    if (pipeline.source.kind !== 'http-poll') continue;
    const itemsPath = pipeline.downstream.split.itemsPath ?? '';
    for (const destination of pipeline.downstream.destinations) {
      const key = `${pipeline.source.url}|${itemsPath}|${destination.url}`;
      const previous = seen.get(key);
      if (previous !== undefined) {
        warnings.push(
          `'${pipeline.id}' (${pipeline.sourceFile}) consulta a mesma origem e entrega no mesmo ` +
            `destino que '${previous}': cada evento sera entregue duas vezes`,
        );
      } else {
        seen.set(key, pipeline.id);
      }
    }
  }
  return warnings;
}
