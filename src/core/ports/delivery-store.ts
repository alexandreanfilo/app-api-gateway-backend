import type { DeliveryRef } from '../types/event';
import type { DedupeKey, DeliveryId, DestinationId, EventId, PipelineId } from '../types/ids';
import type { PersistBody } from '../types/pipeline';

export const DELIVERY_STORE = Symbol('DeliveryStore');

export type DeliveryStatus = 'PENDING' | 'IN_FLIGHT' | 'DELIVERED' | 'FAILED' | 'DISCARDED';

export type DiscardReason =
  | 'NON_RETRYABLE_STATUS'
  | 'ATTEMPTS_EXHAUSTED'
  | 'DESTINATION_REMOVED'
  | 'INVALID_PAYLOAD'
  | 'MANUAL';

export interface NewDelivery {
  readonly id: DeliveryId;
  /** = created_at do EVENTO, nao now(). Mantem evento e entregas na mesma particao. */
  readonly createdAt: Date;
  readonly pipelineId: PipelineId;
  readonly destinationId: DestinationId;
  readonly eventId: EventId;
  readonly dedupeKey: DedupeKey;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly requestMethod: string;
  readonly requestUrl: string;
  readonly traceId?: string;
}

export interface ClaimedDelivery {
  readonly id: DeliveryId;
  readonly createdAt: Date;
  readonly pipelineId: PipelineId;
  readonly destinationId: DestinationId;
  readonly eventId: EventId;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly enqueueSeq: number;
}

export type ClaimMiss =
  | 'ALREADY_TERMINAL'
  | 'LEASE_HELD_BY_OTHER'
  | 'ATTEMPTS_EXHAUSTED'
  | 'NOT_FOUND';

export interface DeliveryOutcomeRecord {
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly requestBodyBytes?: number;
  readonly requestBodySha256?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
  readonly persistBody: PersistBody;
}

export interface DrainCandidate {
  readonly id: DeliveryId;
  readonly createdAt: Date;
  readonly pipelineId: PipelineId;
  readonly destinationId: DestinationId;
  readonly enqueueSeq: number;
  readonly maxAttempts: number;
  readonly attemptCount: number;
}

export interface ReapSummary {
  readonly failed: number;
  readonly discarded: number;
}

export interface DeliveryStore {
  /** Fan-out. Roda na MESMA transacao do insertNewOnly. */
  createMany(rows: readonly NewDelivery[], tx?: unknown): Promise<readonly DeliveryRef[]>;

  /**
   * Claim atomico com lease (fencing). `undefined` nao e erro: e o caso normal
   * de duas encarnacoes do mesmo job chegando ao worker. Lancar aqui faria o
   * BullMQ retentar trabalho que ja nao existe.
   */
  claim(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    leaseSeconds: number,
    workerId: string,
  ): Promise<ClaimedDelivery | undefined>;

  /** Por que o claim falhou. Caminho raro, so para log e metrica. */
  classifyClaimMiss(id: DeliveryId, createdAt: Date): Promise<ClaimMiss>;

  /**
   * Todas as escritas de resultado sao guardadas por lease_token. `false`
   * significa que perdemos a posse da linha -- ou seja, acabou de acontecer uma
   * entrega duplicada. E o unico jeito de a duplicata ser detectavel.
   */
  markDelivered(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
  ): Promise<boolean>;

  markFailed(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
    retryInMs: number,
  ): Promise<boolean>;

  markDiscarded(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string | null,
    reason: DiscardReason,
    outcome?: DeliveryOutcomeRecord,
  ): Promise<boolean>;

  findDrainCandidates(q: {
    graceSeconds: number;
    lookbackDays: number;
    limit: number;
  }): Promise<readonly DrainCandidate[]>;

  bumpEnqueueSeq(id: DeliveryId, createdAt: Date): Promise<number>;
  markDrained(refs: readonly { id: DeliveryId; createdAt: Date }[]): Promise<void>;
  reapExpiredLeases(q: { lookbackDays: number; limit: number }): Promise<ReapSummary>;
  findByDedupeKey(pipelineId: PipelineId, key: DedupeKey): Promise<readonly ClaimedDelivery[]>;
  countByStatus(pipelineId: PipelineId): Promise<Readonly<Record<DeliveryStatus, number>>>;
}
