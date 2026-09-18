import type { DedupeKey, DestinationId, EventId, PipelineId, RunId } from './ids';
import type { JsonObject } from './json';

/**
 * De onde o item veio. Existe para a auditoria e para resolver KeyPart 'header'.
 * Nada mais no motor olha para isto -- se olhar, o discriminante vazou.
 */
export type Origin =
  | {
      readonly kind: 'poll';
      readonly runId: RunId;
      readonly page: number;
      readonly requestUrl: string;
    }
  | {
      readonly kind: 'endpoint';
      readonly runId: RunId;
      readonly headers: Readonly<Record<string, string>>;
      readonly sourceIp: string;
      readonly bodyBytes: number;
    };

export interface RunRef {
  readonly id: RunId;
  readonly createdAt: Date;
}

/** Unidade crua ja normalizada. Poll e endpoint produzem exatamente isto. */
export interface RawItem {
  readonly data: JsonObject;
  readonly receivedAt: Date;
  readonly origin: Origin;
  /** Posicao no lote recebido, para casar a resposta item a item no endpoint. */
  readonly index: number;
}

export interface RawBatch {
  readonly items: readonly RawItem[];
  /** sha256 dos bytes crus (endpoint) ou do corpo da pagina (poll). */
  readonly bodyHash: string;
  readonly run: RunRef;
  readonly page: number;
  readonly httpStatus?: number;
  readonly requestUrl?: string;
  readonly totalRecordCount?: number;
}

/** Item com chave de deduplicacao resolvida, pronto para o banco decidir se e novo. */
export interface KeyedItem {
  readonly dedupeKey: DedupeKey;
  readonly dedupeSource: string;
  readonly item: RawItem;
}

export interface PersistedEvent {
  readonly id: EventId;
  readonly createdAt: Date;
  readonly dedupeKey: DedupeKey;
}

export type RejectReason =
  | 'DEDUPE_KEY_MISSING'
  | 'INVALID_ITEM'
  | 'TRANSFORM_FAILED'
  | 'ITEMS_PATH_NOT_FOUND';

export interface RejectedItem {
  readonly index: number;
  readonly reason: RejectReason;
  readonly detail: string;
}

export type ItemOutcomeStatus = 'accepted' | 'duplicate' | 'filtered' | 'rejected';

export interface ItemOutcome {
  readonly index: number;
  readonly status: ItemOutcomeStatus;
  readonly eventId?: EventId;
  readonly reason?: string;
}

export interface IngestResult {
  readonly pipelineId: PipelineId;
  readonly runId: RunId;
  readonly received: number;
  readonly filteredOut: number;
  readonly duplicates: number;
  readonly accepted: number;
  readonly deliveriesCreated: number;
  readonly enqueued: number;
  readonly pages: number;
  readonly outcomes: readonly ItemOutcome[];
  readonly rejected: readonly RejectedItem[];
}

export interface DeliveryRef {
  readonly id: import('./ids').DeliveryId;
  readonly createdAt: Date;
  readonly destinationId: DestinationId;
  readonly maxAttempts: number;
}
