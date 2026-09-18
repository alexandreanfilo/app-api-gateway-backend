import type { DestinationId, PipelineId } from './ids';
import type { JsonPrimitive, JsonValue } from './json';
import type { SecretRef } from './secret';

// ---------------------------------------------------------------------------
// Specs COMPILADOS. Nao sao o formato do YAML: config/compile-pipeline.ts
// traduz as duas formas de entrada para estas formas unicas, e e exatamente
// essa traducao que impede o discriminante de source.kind de vazar para dentro
// do motor e virar um `switch` duplicado em cada step.
// ---------------------------------------------------------------------------

/**
 * Predicados de filtro. `in` cobre o caso comum (`status: [NP, TP]`); os demais
 * existem porque o legado filtrava por VALIDADE do campo, nao so por pertinencia
 * a um conjunto -- `numero_pedido != 0 && is_numeric(numero_pedido)`.
 */
export type FilterPredicate =
  | { readonly kind: 'in'; readonly values: readonly JsonPrimitive[] }
  | { readonly kind: 'notIn'; readonly values: readonly JsonPrimitive[] }
  | { readonly kind: 'equals'; readonly value: JsonPrimitive }
  | { readonly kind: 'notEquals'; readonly value: JsonPrimitive }
  | { readonly kind: 'numeric' }
  | { readonly kind: 'exists'; readonly present: boolean };

/** Uma regra por campo; AND entre as regras e AND entre os predicados de cada uma. */
export interface FilterRule {
  readonly path: string;
  readonly predicates: readonly FilterPredicate[];
}
export interface FilterSpec {
  readonly rules: readonly FilterRule[];
}

/** itemsPath ausente => o corpo inteiro e um item. */
export interface SplitSpec {
  readonly itemsPath?: string;
}

/**
 * A chave de deduplicacao. No poll so ha partes `field`; no endpoint pode haver
 * `header`. Quem monta a chave nunca precisa saber de onde o item veio.
 */
export type KeyPart =
  | { readonly kind: 'field'; readonly path: string }
  | { readonly kind: 'header'; readonly name: string };

/**
 * Lista de ALTERNATIVAS; a primeira que resolver por completo vence. Esta forma
 * unica cobre os dois casos sem que o motor saiba de qual entrada veio:
 *
 *   poll     fields: [numero_pedido, status]
 *            -> [[field numero_pedido, field status]]        (composta, todas exigidas)
 *   endpoint header: Idempotency-Key + fields: [id_externo]
 *            -> [[header Idempotency-Key], [field id_externo]]  (fallback em cadeia)
 *
 * Sem isso, `buildDedupeKey` precisaria de um `if (source.kind === ...)` e as
 * duas semanticas divergiriam na primeira manutencao.
 */
export interface DedupeSpec {
  readonly alternatives: readonly (readonly KeyPart[])[];
  /** reject: item sem chave e recusado. generate: sha256 do item cru. */
  readonly onMissing: 'reject' | 'generate';
  readonly ttlDays: number;
}

export type CastKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'iso-date'
  | 'epoch-millis'
  | 'trim'
  | 'upper'
  | 'lower';

export type TransformRule =
  | {
      readonly kind: 'from';
      readonly path: string;
      readonly cast?: CastKind;
      readonly fallback?: JsonValue;
      readonly hasFallback: boolean;
    }
  | { readonly kind: 'const'; readonly value: JsonValue };

/** Lista ordenada para que a saida seja deterministica (importa em teste e em diff). */
export interface TransformSpec {
  readonly rules: readonly (readonly [destinationPath: string, rule: TransformRule])[];
}

export type OutboundAuthSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: SecretRef }
  | { readonly kind: 'basic'; readonly username: string; readonly password: SecretRef }
  | { readonly kind: 'api-key'; readonly header: string; readonly value: SecretRef }
  | {
      readonly kind: 'login-token';
      readonly loginUrl: string;
      readonly method: 'POST' | 'GET';
      readonly body: Readonly<Record<string, string | SecretRef>>;
      readonly tokenPath: string;
      readonly header: string;
      readonly scheme: 'bearer' | 'raw';
      readonly ttlSeconds: number;
    };

export type InboundAuthSpec = {
  readonly kind: 'static-token';
  readonly header: string;
  readonly scheme: 'bearer' | 'raw';
  readonly token: SecretRef;
};

export interface RetrySpec {
  readonly attempts: number;
  readonly backoff: 'exponential' | 'fixed';
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  /** 0..1. Anti thundering-herd quando N entregas falham no mesmo segundo. */
  readonly jitter: number;
}

export type PersistBody = 'FULL' | 'TRUNCATED' | 'HASH_ONLY';

export interface DestinationSpec {
  readonly id: DestinationId;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: OutboundAuthSpec;
  readonly retry: RetrySpec;
  readonly timeoutMs: number;
  readonly successStatuses: readonly number[];
  readonly persistBody: PersistBody;
  readonly leaseSeconds: number;
  /**
   * Content-Based Router: o destino so recebe o evento quando o item casa.
   * Vazio = recebe tudo, que e o comportamento normal de fan-out.
   *
   * Avaliado no FAN-OUT, nao na entrega: um destino que nao casa nao gera linha
   * em pipeline_delivery, em vez de gerar uma linha que nasce para ser
   * descartada.
   */
  readonly filter: FilterSpec;
}

export interface PaginationSpec {
  readonly param: string;
  readonly start: number;
  readonly maxPages: number;
}

export interface CompiledPollSource {
  readonly kind: 'http-poll';
  readonly schedule: string;
  readonly timezone: string;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: OutboundAuthSpec;
  readonly pagination?: PaginationSpec;
  readonly itemsPath?: string;
  readonly totalCountPath?: string;
  readonly timeoutMs: number;
}

export interface CompiledEndpointSource {
  readonly kind: 'http-endpoint';
  /** Ja normalizado e prefixado com /in/ pelo compilador. */
  readonly routePath: string;
  readonly methods: readonly string[];
  readonly auth: InboundAuthSpec;
  readonly itemsPath?: string;
  readonly maxBodyBytes: number;
  readonly rateLimitPerMinute?: number;
}

export type CompiledSource = CompiledPollSource | CompiledEndpointSource;

/**
 * `downstream` NAO tem discriminante, e isso e o ponto. Escrever um switch por
 * tipo de entrada exigiria alterar esta interface, o que aparece no diff e no
 * code review em vez de acontecer em silencio dentro de um step.
 */
export interface CompiledPipeline {
  readonly id: PipelineId;
  readonly name: string;
  readonly client: string;
  readonly enabled: boolean;
  readonly sourceFile: string;
  readonly source: CompiledSource;
  readonly runPersistence: 'ALL' | 'ERRORS_ONLY';
  readonly downstream: {
    readonly filter: FilterSpec;
    readonly split: SplitSpec;
    readonly dedupe: DedupeSpec;
    readonly transform: TransformSpec;
    readonly destinations: readonly DestinationSpec[];
  };
}
