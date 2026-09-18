import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Tipos escritos A MAO de proposito, nao gerados.
 *
 * As tabelas nascem do DDL das migrations, que contem particionamento, indices
 * parciais e um indice unico composto que nenhum gerador representa em tipo.
 * Gerar daria a ilusao de fidelidade sem as garantias que importam aqui.
 */

/** Chave de particao: o tipo de UPDATE e `never`. */
type Immutable<T> = ColumnType<T, T, never>;

export type DeliveryStatus = 'PENDING' | 'IN_FLIGHT' | 'DELIVERED' | 'FAILED' | 'DISCARDED';
export type DiscardReason =
  | 'NON_RETRYABLE_STATUS'
  | 'ATTEMPTS_EXHAUSTED'
  | 'DESTINATION_REMOVED'
  | 'INVALID_PAYLOAD'
  | 'MANUAL';
export type RunTrigger = 'POLL' | 'ENDPOINT' | 'MANUAL';
export type RunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'ERROR';

export interface PipelineRunTable {
  id: Immutable<string>;
  created_at: Immutable<Date>;
  pipeline_id: Immutable<string>;
  run_group_id: string | null;
  trigger: RunTrigger;
  status: ColumnType<RunStatus, RunStatus, RunStatus>;
  request_url: string | null;
  request_page: number | null;
  http_status: number | null;
  total_record_count: number | null;
  source_ip: string | null;
  body_bytes: number | null;
  content_type: string | null;
  items_received: Generated<number>;
  items_filtered_out: Generated<number>;
  items_duplicate: Generated<number>;
  items_new: Generated<number>;
  deliveries_created: Generated<number>;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string | null;
  finished_at: Date | null;
}

export interface PipelineEventTable {
  id: Immutable<string>;
  created_at: Immutable<Date>;
  pipeline_id: Immutable<string>;
  dedupe_key: Immutable<string>;
  dedupe_source: string | null;
  run_id: string;
  run_created_at: Date;
  occurred_at: Date | null;
  payload: ColumnType<unknown, string, string>;
  payload_bytes: number;
}

export interface PipelineDeliveryTable {
  id: Immutable<string>;
  /**
   * Chave de particao. `Immutable` faz o TYPESCRIPT recusar um UPDATE aqui; o
   * Postgres permitiria, movendo a linha para outra particao e quebrando a poda
   * e o jobId de uma so vez.
   */
  created_at: Immutable<Date>;
  pipeline_id: Immutable<string>;
  destination_id: Immutable<string>;
  event_id: Immutable<string>;
  dedupe_key: Immutable<string>;
  status: ColumnType<DeliveryStatus, DeliveryStatus | undefined, DeliveryStatus>;
  attempt_count: Generated<number>;
  max_attempts: number;
  next_attempt_at: Generated<Date>;
  enqueue_seq: Generated<number>;
  lease_token: string | null;
  lease_expires_at: Date | null;
  worker_id: string | null;
  request_method: Generated<string>;
  request_url: string;
  request_body: string | null;
  request_body_bytes: number | null;
  request_body_sha256: string | null;
  response_status: number | null;
  response_body: string | null;
  response_headers: ColumnType<unknown, string | null, string | null>;
  error_code: string | null;
  error_message: string | null;
  discard_reason: DiscardReason | null;
  trace_id: string | null;
  first_attempt_at: Date | null;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
  duration_ms: number | null;
  drain_count: Generated<number>;
  last_drained_at: Date | null;
  updated_at: Generated<Date>;
}

export interface PartitionPolicyTable {
  table_name: string;
  months_ahead: Generated<number>;
  keep_months: number;
  last_ensured_at: Date | null;
  last_dropped_at: Date | null;
}

export interface Database {
  pipeline_run: PipelineRunTable;
  pipeline_event: PipelineEventTable;
  pipeline_delivery: PipelineDeliveryTable;
  gw_partition_policy: PartitionPolicyTable;
}

export type RunRow = Selectable<PipelineRunTable>;
export type NewRunRow = Insertable<PipelineRunTable>;
export type RunPatch = Updateable<PipelineRunTable>;

export type EventRow = Selectable<PipelineEventTable>;
export type NewEventRow = Insertable<PipelineEventTable>;

export type DeliveryRow = Selectable<PipelineDeliveryTable>;
export type NewDeliveryRow = Insertable<PipelineDeliveryTable>;
export type DeliveryPatch = Updateable<PipelineDeliveryTable>;
