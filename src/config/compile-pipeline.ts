import {
  asDestinationId,
  asPipelineId,
  type CompiledEndpointSource,
  type CompiledPipeline,
  type CompiledPollSource,
  type DedupeSpec,
  type DestinationSpec,
  type FilterPredicate,
  type FilterRule,
  type FilterSpec,
  type InboundAuthSpec,
  type KeyPart,
  type OutboundAuthSpec,
  type TransformRule,
  type TransformSpec,
} from '../core/types';
import type { InboundAuthInput, OutboundAuthInput } from './schema/auth.schema';
import type { PipelineConfig } from './schema/pipeline.schema';

/**
 * Normaliza o path do endpoint e aplica o prefixo /in/.
 *
 * O prefixo e do CODIGO, nao do YAML: e ele que garante que nenhum pipeline
 * consiga registrar uma rota que colida com /healthz, /metrics ou /admin --
 * independentemente do que o arquivo de configuracao peca.
 */
export function normalizeRoutePath(rawPath: string): string {
  const withoutLeading = rawPath.replace(/^\/+/, '');
  const withoutPrefix = withoutLeading.replace(/^in\//, '');
  const trimmed = withoutPrefix.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return `/in/${trimmed.toLowerCase()}`;
}

/** Header que nao e `Authorization` quase nunca carrega o esquema "Bearer ". */
function defaultScheme(header: string): 'bearer' | 'raw' {
  return header.toLowerCase() === 'authorization' ? 'bearer' : 'raw';
}

function compileOutboundAuth(auth: OutboundAuthInput): OutboundAuthSpec {
  switch (auth.kind) {
    case 'none':
      return { kind: 'none' };
    case 'bearer':
      return { kind: 'bearer', token: auth.token };
    case 'basic':
      return { kind: 'basic', username: auth.username, password: auth.password };
    case 'api-key':
      return { kind: 'api-key', header: auth.header, value: auth.value };
    case 'login-token':
      return {
        kind: 'login-token',
        loginUrl: auth.loginUrl,
        method: auth.method,
        body: auth.body,
        tokenPath: auth.tokenPath,
        header: auth.header,
        scheme: auth.scheme ?? defaultScheme(auth.header),
        ttlSeconds: auth.ttlSeconds,
      };
  }
}

function compileInboundAuth(auth: InboundAuthInput): InboundAuthSpec {
  return {
    kind: 'static-token',
    header: auth.header,
    scheme: auth.scheme ?? defaultScheme(auth.header),
    token: auth.value,
  };
}

/**
 * Traduz as duas formas do YAML para UMA forma compilada.
 *
 * O atalho `status: [NP, TP]` vira exatamente o mesmo `{ kind: 'in' }` que a
 * forma longa produziria -- o motor nunca sabe qual das duas o operador
 * escreveu, que e o ponto de existir um passo de compilacao.
 */
function compileFilter(filter: PipelineConfig['filter']): FilterSpec {
  const rules: FilterRule[] = [];

  for (const [path, declared] of Object.entries(filter)) {
    if (Array.isArray(declared)) {
      rules.push({ path, predicates: [{ kind: 'in', values: declared }] });
      continue;
    }

    const predicates: FilterPredicate[] = [];
    if (declared.in !== undefined) predicates.push({ kind: 'in', values: declared.in });
    if (declared.notIn !== undefined) predicates.push({ kind: 'notIn', values: declared.notIn });
    if (declared.equals !== undefined) predicates.push({ kind: 'equals', value: declared.equals });
    if (declared.notEquals !== undefined) {
      predicates.push({ kind: 'notEquals', value: declared.notEquals });
    }
    if (declared.numeric === true) predicates.push({ kind: 'numeric' });
    if (declared.exists !== undefined)
      predicates.push({ kind: 'exists', present: declared.exists });

    rules.push({ path, predicates });
  }

  return { rules };
}

/**
 * As duas formas de `dedupe` do YAML viram UMA forma compilada.
 *
 * E aqui que o discriminante morre. Sem esta traducao, `buildDedupeKey` teria um
 * `if (source.kind === 'http-endpoint')` e, tres meses depois, dois caminhos
 * divergentes com semanticas sutilmente diferentes.
 */
function compileDedupe(
  dedupe: PipelineConfig['dedupe'],
  sourceKind: 'http-poll' | 'http-endpoint',
): DedupeSpec {
  const alternatives: KeyPart[][] = [];

  if (dedupe.header !== undefined) {
    // No endpoint, header e payload sao ALTERNATIVAS em cadeia: a primeira que
    // resolver vence ("se as duas faltarem, ver onMissing").
    alternatives.push([{ kind: 'header', name: dedupe.header }]);
    if (dedupe.fields.length > 0) {
      alternatives.push(dedupe.fields.map((path) => ({ kind: 'field', path }) as const));
    }
  } else if (dedupe.fields.length > 0) {
    // No poll, os campos formam uma chave COMPOSTA: todos obrigatorios.
    alternatives.push(dedupe.fields.map((path) => ({ kind: 'field', path }) as const));
  }

  return {
    alternatives,
    onMissing: dedupe.onMissing ?? (sourceKind === 'http-poll' ? 'reject' : 'reject'),
    ttlDays: dedupe.ttlDays,
  };
}

function compileTransform(transform: PipelineConfig['transform']): TransformSpec {
  const rules: (readonly [string, TransformRule])[] = [];
  // Ordem estavel: a saida precisa ser deterministica para teste e para diff.
  for (const destination of Object.keys(transform).sort()) {
    const rule = transform[destination];
    if (rule === undefined) continue;
    if (rule.const !== undefined) {
      rules.push([destination, { kind: 'const', value: rule.const }]);
      continue;
    }
    if (rule.from === undefined) continue;
    rules.push([
      destination,
      {
        kind: 'from',
        path: rule.from,
        ...(rule.cast !== undefined ? { cast: rule.cast } : {}),
        hasFallback: rule.default !== undefined,
        ...(rule.default !== undefined ? { fallback: rule.default } : {}),
      },
    ]);
  }
  return { rules };
}

function compileDestination(destination: PipelineConfig['destinations'][number]): DestinationSpec {
  return {
    id: asDestinationId(destination.id),
    method: destination.method,
    url: destination.url,
    headers: destination.headers,
    auth: compileOutboundAuth(destination.auth),
    retry: destination.retry,
    timeoutMs: destination.timeoutMs,
    successStatuses: destination.successStatuses,
    persistBody: destination.persistBody,
    filter: compileFilter(destination.filter),
    // O lease precisa cobrir a tentativa HTTP inteira com folga: um lease que
    // vence enquanto o request esta em voo faz outro worker reivindicar a mesma
    // entrega e entregar duas vezes -- de forma sistematica, nao rara.
    leaseSeconds: Math.ceil((destination.timeoutMs * 3) / 1000) + 30,
  };
}

function compileSource(config: PipelineConfig): CompiledPollSource | CompiledEndpointSource {
  if (config.source.kind === 'http-poll') {
    const source = config.source;
    return {
      kind: 'http-poll',
      schedule: source.schedule,
      timezone: source.timezone,
      method: source.method,
      url: source.url,
      query: source.query,
      headers: source.headers,
      auth: compileOutboundAuth(source.auth),
      ...(source.pagination !== undefined ? { pagination: source.pagination } : {}),
      ...(source.itemsPath !== undefined ? { itemsPath: source.itemsPath } : {}),
      ...(source.totalCountPath !== undefined ? { totalCountPath: source.totalCountPath } : {}),
      timeoutMs: source.timeoutMs,
    };
  }

  const source = config.source;
  return {
    kind: 'http-endpoint',
    routePath: normalizeRoutePath(source.path),
    methods: source.methods,
    auth: compileInboundAuth(source.auth),
    ...(source.itemsPath !== undefined ? { itemsPath: source.itemsPath } : {}),
    maxBodyBytes: source.maxBodyBytes,
    ...(source.rateLimit !== undefined ? { rateLimitPerMinute: source.rateLimit.perMinute } : {}),
  };
}

export function compilePipeline(config: PipelineConfig, sourceFile: string): CompiledPipeline {
  const source = compileSource(config);
  return {
    id: asPipelineId(config.id),
    name: config.name,
    client: config.client,
    enabled: config.enabled,
    sourceFile,
    source,
    runPersistence: config.runPersistence,
    downstream: {
      filter: compileFilter(config.filter),
      // `itemsPath` e declarado em `source` no YAML mas e um passo A JUSANTE:
      // o Splitter e identico nos dois tipos de entrada, e e por isso que ele
      // atravessa a fronteira e vira `downstream.split`.
      split: {
        ...(config.source.itemsPath !== undefined ? { itemsPath: config.source.itemsPath } : {}),
      },
      dedupe: compileDedupe(config.dedupe, config.source.kind),
      transform: compileTransform(config.transform),
      destinations: config.destinations.map(compileDestination),
    },
  };
}

/** Todos os refs de segredo do pipeline, com o caminho no YAML para a mensagem de erro. */
export function collectSecretRefs(
  config: PipelineConfig,
): readonly { name: string; path: string }[] {
  const refs: { name: string; path: string }[] = [];

  const fromOutbound = (auth: OutboundAuthInput, prefix: string): void => {
    switch (auth.kind) {
      case 'bearer':
        refs.push({ name: auth.token.secret, path: `${prefix}.token` });
        break;
      case 'basic':
        refs.push({ name: auth.password.secret, path: `${prefix}.password` });
        break;
      case 'api-key':
        refs.push({ name: auth.value.secret, path: `${prefix}.value` });
        break;
      case 'login-token':
        for (const [field, value] of Object.entries(auth.body)) {
          if (typeof value !== 'string') {
            refs.push({ name: value.secret, path: `${prefix}.body.${field}` });
          }
        }
        break;
      case 'none':
        break;
    }
  };

  if (config.source.kind === 'http-poll') {
    fromOutbound(config.source.auth, 'source.auth');
  } else {
    refs.push({ name: config.source.auth.value.secret, path: 'source.auth.value' });
  }
  for (const [index, destination] of config.destinations.entries()) {
    fromOutbound(destination.auth, `destinations[${index}].auth`);
  }
  return refs;
}
