/**
 * Execucao ASSISTIDA de um pipeline de poll, passo a passo, contra os
 * endpoints REAIS -- origem de producao e destino de producao.
 *
 * Existe porque o app so sabe executar por cron: sobe, registra um CronJob por
 * pipeline e coleta sozinho a cada 5 minutos, entregando tudo o que passou no
 * filtro. Para a PRIMEIRA execucao de um fluxo migrado isso e cedo demais --
 * ninguem viu ainda o que a origem devolve, nem o corpo que o transform
 * produz, e o destino e o TSM de verdade. Aqui cada etapa e um comando
 * separado, e nenhum byte sai para o destino sem confirmacao explicita.
 *
 * Os passos usam as MESMAS funcoes do motor (resolveQueryPlaceholders,
 * buildOutboundAuthHeaders, splitBody, applyFilters, buildDedupeKey,
 * applyTransform) e os mesmos headers que o DeliveryProcessor monta. O que
 * este script NAO faz e persistir: nao grava pipeline_run, pipeline_event nem
 * pipeline_delivery, e portanto nao exercita a deduplicacao entre execucoes
 * nem o retry -- isso so acontece com o app no ar. Aqui a memoria e o arquivo
 * de plano em tmp/, e a defesa contra entrega dupla e o Idempotency-Key, que
 * e gravado no plano e reenviado identico se voce repetir um envio.
 *
 * Uso, a partir da raiz do repositorio -- sempre por `npm run`, que e quem
 * carrega o .env (`tsx` chamado na mao nao carrega, e ai todo segredo falta):
 *   npm run fluxo -- consultar <pipeline-id> [--pagina N]
 *   npm run fluxo -- preparar  <pipeline-id> [--pagina N]
 *   npm run fluxo -- plano     <pipeline-id>
 *   npm run fluxo -- enviar    <pipeline-id> <indice>
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ConfigError, formatConfigError } from '../src/config/config-error';
import { loadGatewayConfig } from '../src/config/load-config';
import { EnvSecretResolver } from '../src/config/secrets/env-secret-resolver';
import { systemClock } from '../src/core/ports/clock';
import type { HttpOutcome } from '../src/core/ports/http-client';
import type { Metrics } from '../src/core/ports/metrics';
import type { TokenCache } from '../src/core/ports/token-cache';
import { maskUrl } from '../src/core/redaction/mask';
import { buildOutboundAuthHeaders } from '../src/core/steps/auth';
import { stripNulChars } from '../src/core/steps/canonical';
import { classify } from '../src/core/steps/classify';
import { resolveQueryPlaceholders } from '../src/core/steps/date-placeholders';
import { buildDedupeKey } from '../src/core/steps/dedupe';
import { applyFilters } from '../src/core/steps/filter';
import { getPath } from '../src/core/steps/path';
import { splitBody } from '../src/core/steps/split';
import { applyTransform } from '../src/core/steps/transform';
import type { RawItem } from '../src/core/types/event';
import { asRunId } from '../src/core/types/ids';
import { isJsonObject, type JsonObject, type JsonValue } from '../src/core/types/json';
import type {
  CompiledPipeline,
  CompiledPollSource,
  OutboundAuthSpec,
} from '../src/core/types/pipeline';
import { UndiciHttpClient } from '../src/http/undici-http-client';

const PLANOS_DIR = 'tmp';

/** Uma entrega candidata, ja com o corpo final que iria ao destino. */
interface ItemPlanejado {
  readonly indice: number;
  readonly dedupeKey: string;
  readonly dedupeSource: string;
  /** Fixos no plano: reenviar o mesmo indice repete a MESMA chave. */
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly origem: JsonObject;
  readonly corpo: JsonObject;
  enviado?: {
    readonly quando: string;
    readonly destino: string;
    readonly status: number | string;
    /** Veredito do mesmo classify() que o DeliveryProcessor usa. */
    readonly classificacao: string;
    readonly resposta: string;
  };
}

interface Plano {
  readonly pipelineId: string;
  readonly preparadoEm: string;
  readonly pagina: number;
  readonly url: string;
  readonly contagem: {
    readonly recebidos: number;
    readonly filtrados: number;
    readonly semChave: number;
    readonly prontos: number;
  };
  readonly itens: ItemPlanejado[];
}

// --- portas minimas ---------------------------------------------------------
// O script nao mede nada e nao compartilha token com replica nenhuma: as duas
// portas existem so para satisfazer a assinatura de buildOutboundAuthHeaders.
const metrics = new Proxy({} as Metrics, { get: () => () => {} });

const memoria = new Map<string, string>();
const cache: TokenCache = {
  async get(chave) {
    return memoria.get(chave);
  },
  async set(chave, valor) {
    memoria.set(chave, valor);
  },
  async invalidate(chave) {
    memoria.delete(chave);
  },
};

const http = new UndiciHttpClient();
const secrets = new EnvSecretResolver();

// --- apoio ------------------------------------------------------------------

function arquivoDoPlano(pipelineId: string): string {
  return join(PLANOS_DIR, `execucao-${pipelineId}.json`);
}

function abortar(mensagem: string): never {
  process.stderr.write(`${mensagem}\n`);
  process.exit(1);
}

/** Nomes de segredo que ESTE pipeline usa -- origem e destinos. */
function segredosDoPipeline(pipeline: CompiledPipeline): string[] {
  const nomes: string[] = [];
  const daAuth = (auth: OutboundAuthSpec): void => {
    switch (auth.kind) {
      case 'bearer':
        nomes.push(auth.token.secret);
        break;
      case 'basic':
        nomes.push(auth.password.secret);
        break;
      case 'api-key':
        nomes.push(auth.value.secret);
        break;
      case 'login-token':
        for (const valor of Object.values(auth.body)) {
          if (typeof valor !== 'string') nomes.push(valor.secret);
        }
        break;
      default:
        break;
    }
  };
  if (pipeline.source.kind === 'http-poll') daAuth(pipeline.source.auth);
  for (const destino of pipeline.downstream.destinations) daAuth(destino.auth);
  return nomes;
}

async function carregarPipeline(id: string): Promise<CompiledPipeline> {
  // `checkSecrets: false` de proposito, ao contrario do boot: aqui se executa UM
  // fluxo por vez, e exigir o segredo dos outros impediria testar o primeiro
  // terminal antes de a credencial dos demais ter sido provisionada. A cobranca
  // vem logo abaixo, restrita ao fluxo escolhido.
  const config = await loadGatewayConfig({
    dir: process.env.PIPELINES_DIR ?? './pipelines',
    secrets,
    env: process.env,
    checkSecrets: false,
  });
  const pipeline = config.pipelines.find((p) => p.id === id);
  if (pipeline === undefined) {
    const nomes = config.pipelines.map((p) => p.id).join(', ');
    abortar(`pipeline '${id}' nao esta carregado. Habilitados: ${nomes || '(nenhum)'}`);
  }
  if (pipeline.source.kind !== 'http-poll') {
    abortar(`pipeline '${id}' e de entrada por endpoint; este script executa apenas http-poll`);
  }

  const faltando: string[] = [];
  for (const nome of segredosDoPipeline(pipeline)) {
    if (!(await secrets.exists(nome))) faltando.push(nome);
  }
  if (faltando.length > 0) {
    abortar(
      `faltam no ambiente ${faltando.length} segredo(s) deste fluxo: ${faltando.join(', ')}\n` +
        'Preencha no .env e rode por `npm run fluxo -- ...`, que e quem carrega o arquivo.',
    );
  }
  return pipeline;
}

function montarUrl(
  spec: CompiledPollSource,
  query: Record<string, string>,
  pagina: number,
): string {
  const url = new URL(spec.url);
  for (const [chave, valor] of Object.entries(query)) url.searchParams.set(chave, valor);
  if (spec.pagination !== undefined) url.searchParams.set(spec.pagination.param, String(pagina));
  return url.toString();
}

function descreverHeaders(headers: Readonly<Record<string, unknown>>): string {
  // Valor de credencial nunca e impresso: o que importa conferir e QUAL header
  // vai, nao o segredo -- esse ja foi conferido quando entrou no ambiente.
  return Object.keys(headers)
    .map((k) => `       ${k}: ***`)
    .join('\n');
}

function resumoDaResposta(outcome: HttpOutcome): string {
  if (outcome.kind === 'network') return `ERRO DE REDE ${outcome.code}: ${outcome.message}`;
  return `HTTP ${outcome.status} em ${outcome.durationMs}ms`;
}

/** Consulta uma pagina da origem. Nao grava nada: e so leitura. */
async function consultarPagina(
  pipeline: CompiledPipeline,
  pagina: number,
): Promise<{ url: string; documento: JsonObject; outcome: HttpOutcome }> {
  const spec = pipeline.source as CompiledPollSource;
  const agora = systemClock.now();
  const query = resolveQueryPlaceholders(spec.query, agora, spec.timezone);
  const authHeaders = await buildOutboundAuthHeaders(spec.auth, pipeline.id, {
    secrets,
    http,
    cache,
    clock: systemClock,
    metrics,
  });
  const url = montarUrl(spec, query, pagina);

  console.log(`   ${spec.method} ${maskUrl(url)}`);
  console.log(`   query resolvida: ${JSON.stringify(query)}  [${spec.timezone}]`);
  console.log('   headers:');
  console.log(descreverHeaders({ ...spec.headers, ...authHeaders, accept: 'application/json' }));

  const outcome = await http.send({
    method: spec.method,
    url,
    headers: { ...spec.headers, ...authHeaders, accept: 'application/json' },
    timeoutMs: spec.timeoutMs,
  });

  console.log(`   -> ${resumoDaResposta(outcome)}`);
  if (outcome.kind === 'network') abortar('a origem nao respondeu; nada a fazer');
  if (outcome.status < 200 || outcome.status >= 300) {
    console.log(`   corpo: ${outcome.body.slice(0, 500)}`);
    abortar(`a origem respondeu HTTP ${outcome.status}`);
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(outcome.body) as JsonValue;
  } catch {
    abortar('a origem nao devolveu JSON');
  }
  const documento: JsonObject = isJsonObject(parsed) ? parsed : { value: parsed };

  if (spec.totalCountPath !== undefined) {
    const total = getPath(documento, spec.totalCountPath);
    console.log(`   ${spec.totalCountPath}: ${JSON.stringify(total)}`);
  }
  return { url, documento, outcome };
}

// --- comandos ---------------------------------------------------------------

async function consultar(id: string, pagina: number): Promise<void> {
  const pipeline = await carregarPipeline(id);
  console.log(`\n== CONSULTA  ${pipeline.name}  (pagina ${pagina})\n`);

  const { documento } = await consultarPagina(pipeline, pagina);
  const split = splitBody(pipeline.downstream.split.itemsPath, documento);
  if (!split.ok) abortar(`itemsPath nao resolveu: ${split.error.detail}`);

  console.log(`\n   itens na pagina: ${split.value.length}`);
  if (split.value[0] !== undefined) {
    console.log('\n   primeiro item, cru, como a origem devolveu:');
    console.log(`${JSON.stringify(split.value[0], null, 2)}`);
  }
  console.log('\nNada foi enviado a lugar nenhum. Proximo passo: `preparar`.\n');
}

async function preparar(id: string, pagina: number): Promise<void> {
  const pipeline = await carregarPipeline(id);
  console.log(`\n== PREPARO  ${pipeline.name}  (pagina ${pagina})\n`);

  const { url, documento } = await consultarPagina(pipeline, pagina);
  const { downstream } = pipeline;

  const split = splitBody(downstream.split.itemsPath, documento);
  if (!split.ok) abortar(`itemsPath nao resolveu: ${split.error.detail}`);

  // Mesma ordem do motor: split -> filtro -> chave -> transform. Filtrar antes
  // do split descartaria o lote inteiro, porque a pagina nao tem `status`.
  const itens: RawItem[] = split.value.map((data, indice) => ({
    data: stripNulChars(data) as JsonObject,
    receivedAt: systemClock.now(),
    index: indice,
    origin: { kind: 'poll', runId: asRunId('execucao-assistida'), page: pagina, requestUrl: url },
  }));

  const mantidos = applyFilters(downstream.filter)(itens);
  const fazerChave = buildDedupeKey(downstream.dedupe);
  const transformar = applyTransform(downstream.transform);

  const planejados: ItemPlanejado[] = [];
  let semChave = 0;
  for (const item of mantidos) {
    const chave = fazerChave(item);
    if (!chave.ok) {
      semChave += 1;
      console.log(`   ! item ${item.index} sem chave de dedupe: ${chave.error.detail}`);
      continue;
    }
    const corpo = transformar(item.data);
    if (!corpo.ok) {
      semChave += 1;
      console.log(`   ! item ${item.index} falhou no transform: ${corpo.error.detail}`);
      continue;
    }
    planejados.push({
      indice: planejados.length,
      dedupeKey: chave.value.dedupeKey as string,
      dedupeSource: chave.value.dedupeSource,
      idempotencyKey: randomUUID(),
      eventId: randomUUID(),
      origem: item.data,
      corpo: corpo.value,
    });
  }

  const plano: Plano = {
    pipelineId: pipeline.id,
    preparadoEm: new Date().toISOString(),
    pagina,
    url: maskUrl(url),
    contagem: {
      recebidos: itens.length,
      filtrados: itens.length - mantidos.length,
      semChave,
      prontos: planejados.length,
    },
    itens: planejados,
  };

  mkdirSync(PLANOS_DIR, { recursive: true });
  writeFileSync(arquivoDoPlano(pipeline.id), `${JSON.stringify(plano, null, 2)}\n`);

  console.log(
    `\n   recebidos ${plano.contagem.recebidos}` +
      `  |  descartados pelo filtro ${plano.contagem.filtrados}` +
      `  |  sem chave/transform ${plano.contagem.semChave}` +
      `  |  PRONTOS ${plano.contagem.prontos}`,
  );
  imprimirPlano(plano);
  console.log(`plano gravado em ${arquivoDoPlano(pipeline.id)}`);
  console.log('Continua sem nada enviado. Proximo passo: `enviar <indice>`.\n');
}

function lerPlano(id: string): Plano {
  try {
    return JSON.parse(readFileSync(arquivoDoPlano(id), 'utf8')) as Plano;
  } catch {
    return abortar(`sem plano para '${id}'. Rode o comando 'preparar' antes.`);
  }
}

function imprimirPlano(plano: Plano): void {
  console.log('\n   indice  situacao    dedupe                       corpo para o destino');
  for (const item of plano.itens) {
    const situacao =
      item.enviado === undefined ? 'pendente  ' : `${String(item.enviado.status).padEnd(10)}`;
    console.log(
      `   ${String(item.indice).padStart(6)}  ${situacao}  ` +
        `${item.dedupeSource.slice(0, 26).padEnd(26)}  ${JSON.stringify(item.corpo)}`,
    );
  }
  console.log('');
}

async function plano(id: string): Promise<void> {
  const atual = lerPlano(id);
  console.log(`\n== PLANO  ${atual.pipelineId}  (preparado em ${atual.preparadoEm})`);
  console.log(`   origem: ${atual.url}  pagina ${atual.pagina}`);
  imprimirPlano(atual);
}

async function enviar(id: string, indice: number): Promise<void> {
  const pipeline = await carregarPipeline(id);
  const atual = lerPlano(id);
  const item = atual.itens.find((i) => i.indice === indice);
  if (item === undefined) abortar(`indice ${indice} nao existe no plano`);

  const destino = pipeline.downstream.destinations[0];
  if (destino === undefined) abortar('pipeline sem destino');

  const authHeaders = await buildOutboundAuthHeaders(destino.auth, pipeline.id, {
    secrets,
    http,
    cache,
    clock: systemClock,
    metrics,
  });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'idempotency-key': item.idempotencyKey,
    'x-event-id': item.eventId,
    'x-delivery-attempt': '1',
    ...destino.headers,
    ...authHeaders,
  };
  const corpo = JSON.stringify(item.corpo);

  console.log(`\n== ENVIO  item ${indice}  ->  destino '${destino.id}'\n`);
  console.log(`   ${destino.method} ${maskUrl(destino.url)}`);
  console.log('   headers:');
  console.log(descreverHeaders(headers));
  console.log(`   idempotency-key: ${item.idempotencyKey}`);
  console.log('\n   item na origem:');
  console.log(JSON.stringify(item.origem, null, 2));
  console.log('\n   CORPO QUE SERA ENVIADO:');
  console.log(JSON.stringify(item.corpo, null, 2));

  if (item.enviado !== undefined) {
    console.log(
      `\n   ATENCAO: este indice ja foi enviado em ${item.enviado.quando}` +
        ` (${item.enviado.status}). Reenviar repete o MESMO idempotency-key.`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const resposta = (await rl.question('\n   Enviar para o destino REAL? [s/N] ')).trim();
  rl.close();
  if (resposta.toLowerCase() !== 's') {
    console.log('   cancelado; nada foi enviado.\n');
    return;
  }

  const outcome = await http.send({
    method: destino.method,
    url: destino.url,
    headers,
    body: corpo,
    timeoutMs: destino.timeoutMs,
  });

  console.log(`\n   -> ${resumoDaResposta(outcome)}`);
  if (outcome.kind === 'response') console.log(`   corpo: ${outcome.body.slice(0, 1000)}`);

  // Quem decide e o MESMO classify() do DeliveryProcessor, e nao uma regra
  // parecida escrita aqui. Uma regra parecida ja mentiu uma vez: comparar o
  // status com `successStatuses` diretamente marca todo 2xx como recusado nos
  // destinos que nao declaram a lista -- e nenhum dos fluxos migrados declara.
  const classificacao = classify(outcome, destino, systemClock.now());
  const veredito =
    classificacao.kind === 'SUCCESS'
      ? 'ACEITO pelo destino'
      : classificacao.kind === 'NON_RETRYABLE'
        ? `RECUSADO (${classificacao.why}) -- o motor NAO retentaria isto`
        : `FALHOU (${classificacao.why}) -- o motor retentaria`;
  console.log(`   ${veredito}\n`);

  item.enviado = {
    quando: new Date().toISOString(),
    destino: destino.id,
    status: outcome.kind === 'response' ? outcome.status : outcome.code,
    classificacao: classificacao.kind,
    resposta: outcome.kind === 'response' ? outcome.body.slice(0, 1000) : outcome.message,
  };
  writeFileSync(arquivoDoPlano(id), `${JSON.stringify(atual, null, 2)}\n`);

  const pendentes = atual.itens.filter((i) => i.enviado === undefined).length;
  console.log(`   restam ${pendentes} item(ns) pendente(s) no plano.\n`);
}

// --- entrada ----------------------------------------------------------------

async function main(): Promise<void> {
  const [comando, id, terceiro] = process.argv.slice(2);
  const paginaFlag = process.argv.indexOf('--pagina');
  const pagina = paginaFlag === -1 ? 1 : Number(process.argv[paginaFlag + 1] ?? 1);

  if (comando === undefined || id === undefined) {
    abortar(
      'uso: executar-fluxo.ts <consultar|preparar|plano|enviar> <pipeline-id> [indice] [--pagina N]',
    );
  }

  switch (comando) {
    case 'consultar':
      return consultar(id, pagina);
    case 'preparar':
      return preparar(id, pagina);
    case 'plano':
      return plano(id);
    case 'enviar': {
      if (terceiro === undefined)
        abortar('informe o indice do item: enviar <pipeline-id> <indice>');
      return enviar(id, Number(terceiro));
    }
    default:
      abortar(`comando desconhecido: ${comando}`);
  }
}

void main().catch((erro: unknown) => {
  // Mesmo tratamento do main.ts: quem le isto quer saber qual campo de qual
  // arquivo esta errado, nao a pilha de chamadas do carregador.
  if (erro instanceof ConfigError) abortar(formatConfigError(erro));
  abortar(erro instanceof Error ? erro.message : String(erro));
});
