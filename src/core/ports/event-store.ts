import type { PersistedEvent } from '../types/event';
import type { DedupeKey, EventId, PipelineId, RunId } from '../types/ids';
import type { JsonObject } from '../types/json';

export const EVENT_STORE = Symbol('EventStore');

export interface NewEventInput {
  readonly pipelineId: PipelineId;
  readonly dedupeKey: DedupeKey;
  readonly dedupeSource: string;
  readonly runId: RunId;
  readonly runCreatedAt: Date;
  readonly occurredAt?: Date;
  readonly payload: JsonObject;
}

export interface DedupeResult {
  /** SO os novos. Somente estes viram entrega e vao para a fila. */
  readonly inserted: readonly PersistedEvent[];
  readonly duplicateKeys: readonly DedupeKey[];
  readonly receivedCount: number;
  /** Duplicatas dentro do proprio lote: sinal de bug no split ou na chave. */
  readonly intraBatchDupes: number;
}

export interface EventStore {
  /**
   * Dedupe em lote. O banco decide o que e novo, via
   * INSERT ... ON CONFLICT (pipeline_id, dedupe_key) DO NOTHING RETURNING.
   *
   * SELECT-entao-INSERT tem corrida real entre dois workers e entre worker e
   * request HTTP simultaneos: sob concorrencia, duplicatas passam. A semantica
   * e do indice unico, nao do codigo.
   */
  insertNewOnly(items: readonly NewEventInput[], tx?: unknown): Promise<DedupeResult>;

  findByDedupeKey(pipelineId: PipelineId, key: DedupeKey): Promise<PersistedEvent | undefined>;
  /**
   * Em lote, porque o endpoint responde 200 com o id do EVENTO ORIGINAL para
   * cada duplicata: uma consulta por item transformaria um reenvio de 500 itens
   * em 500 idas ao banco dentro da requisicao.
   */
  findManyByDedupeKey(
    pipelineId: PipelineId,
    keys: readonly DedupeKey[],
    tx?: unknown,
  ): Promise<readonly PersistedEvent[]>;
  payloadOf(eventId: EventId): Promise<JsonObject | undefined>;
  purgeOlderThan(days: number, batchSize: number): Promise<number>;
}
