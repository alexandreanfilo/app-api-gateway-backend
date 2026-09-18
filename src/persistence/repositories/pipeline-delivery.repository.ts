import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  ClaimedDelivery,
  ClaimMiss,
  DeliveryOutcomeRecord,
  DeliveryStatus,
  DeliveryStore,
  DiscardReason,
  DrainCandidate,
  NewDelivery,
  ReapSummary,
} from '../../core/ports/delivery-store';
import { sha256Hex } from '../../core/steps/canonical';
import type { DeliveryRef } from '../../core/types/event';
import {
  asDeliveryId,
  asDestinationId,
  asEventId,
  asPipelineId,
  type DedupeKey,
  type DeliveryId,
  type PipelineId,
} from '../../core/types/ids';
import type { PersistBody } from '../../core/types/pipeline';
import { DATABASE, type Db } from '../database';
import {
  DEFAULT_PERSISTENCE_OPTIONS,
  PERSISTENCE_OPTIONS,
  type PersistenceOptions,
} from '../persistence.tokens';
import type { NewDeliveryRow } from '../schema';
import { chunked, executor, withPartitionRecovery } from './support';

const MAX_REQUEST_BODY = 8 * 1024;
const MAX_RESPONSE_BODY = 4 * 1024;

function truncateBody(body: string | undefined, persist: PersistBody, max: number): string | null {
  if (body === undefined) return null;
  if (persist === 'HASH_ONLY') return null;
  if (persist === 'FULL') return body;
  return body.length > max ? `${body.slice(0, max)}...[truncado]` : body;
}

@Injectable()
export class PipelineDeliveryRepository implements DeliveryStore {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(PERSISTENCE_OPTIONS)
    private readonly options: PersistenceOptions = DEFAULT_PERSISTENCE_OPTIONS,
  ) {}

  async createMany(rows: readonly NewDelivery[], tx?: unknown): Promise<readonly DeliveryRef[]> {
    if (rows.length === 0) return [];
    const db = executor(this.db, tx);

    const values: NewDeliveryRow[] = rows.map((row) => ({
      id: row.id,
      created_at: row.createdAt,
      pipeline_id: row.pipelineId,
      destination_id: row.destinationId,
      event_id: row.eventId,
      dedupe_key: row.dedupeKey,
      status: 'PENDING',
      max_attempts: row.maxAttempts,
      next_attempt_at: row.nextAttemptAt,
      request_method: row.requestMethod,
      request_url: row.requestUrl,
      trace_id: row.traceId ?? null,
    }));

    await withPartitionRecovery(
      this.db,
      'pipeline_delivery',
      this.options.partitionMonthsAhead,
      async () => {
        for (const chunk of chunked(values)) {
          await db.insertInto('pipeline_delivery').values(chunk).execute();
        }
      },
      this.options.onPartitionRecovered,
    );

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      destinationId: row.destinationId,
      maxAttempts: row.maxAttempts,
    }));
  }

  /**
   * Uma unica ida ao banco: verifica estado, teto de tentativas e lease
   * expirado, incrementa o contador e devolve a linha. Tudo atomico.
   *
   * `attempt_count` incrementa AQUI, antes do HTTP, de proposito: um payload que
   * derruba o processo consome tentativas e acaba DISCARDED, em vez de derrubar
   * a frota em laco infinito. Um crash custa uma tentativa, e e o preco certo.
   */
  async claim(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    leaseSeconds: number,
    workerId: string,
  ): Promise<ClaimedDelivery | undefined> {
    const result = await sql<{
      id: string;
      created_at: Date;
      pipeline_id: string;
      destination_id: string;
      event_id: string;
      attempt_count: number;
      max_attempts: number;
      enqueue_seq: number;
    }>`
      UPDATE pipeline_delivery
         SET status           = 'IN_FLIGHT',
             attempt_count    = attempt_count + 1,
             lease_token      = ${leaseToken}::uuid,
             lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
             worker_id        = ${workerId},
             first_attempt_at = coalesce(first_attempt_at, now()),
             last_attempt_at  = now(),
             updated_at       = now()
       WHERE id         = ${id}::uuid
         AND created_at = ${createdAt}
         AND attempt_count < max_attempts
         AND ( status IN ('PENDING','FAILED')
            OR (status = 'IN_FLIGHT' AND lease_expires_at < now()) )
      RETURNING id, created_at, pipeline_id, destination_id, event_id,
                attempt_count, max_attempts, enqueue_seq
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: asDeliveryId(row.id),
      createdAt: row.created_at,
      pipelineId: asPipelineId(row.pipeline_id),
      destinationId: asDestinationId(row.destination_id),
      eventId: asEventId(row.event_id),
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      enqueueSeq: row.enqueue_seq,
    };
  }

  async classifyClaimMiss(id: DeliveryId, createdAt: Date): Promise<ClaimMiss> {
    const row = await this.db
      .selectFrom('pipeline_delivery')
      .select(['status', 'attempt_count', 'max_attempts', 'lease_expires_at'])
      .where('id', '=', id)
      .where('created_at', '=', createdAt)
      .executeTakeFirst();

    if (row === undefined) return 'NOT_FOUND';
    if (row.status === 'DELIVERED' || row.status === 'DISCARDED') return 'ALREADY_TERMINAL';
    if (row.attempt_count >= row.max_attempts) return 'ATTEMPTS_EXHAUSTED';
    return 'LEASE_HELD_BY_OTHER';
  }

  /**
   * Guardada por lease_token (fencing). `false` significa que perdemos a posse
   * da linha para outra instancia -- ou seja, acabou de acontecer uma entrega
   * duplicada. E o unico jeito de a duplicata ser DETECTAVEL em vez de invisivel.
   */
  async markDelivered(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('pipeline_delivery')
      .set({
        status: 'DELIVERED',
        delivered_at: new Date(),
        ...this.outcomeColumns(outcome),
        error_code: null,
        error_message: null,
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('created_at', '=', createdAt)
      .where('status', '=', 'IN_FLIGHT')
      .where('lease_token', '=', leaseToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async markFailed(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
    retryInMs: number,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('pipeline_delivery')
      .set({
        status: 'FAILED',
        ...this.outcomeColumns(outcome),
        next_attempt_at: new Date(Date.now() + retryInMs),
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('created_at', '=', createdAt)
      .where('status', '=', 'IN_FLIGHT')
      .where('lease_token', '=', leaseToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async markDiscarded(
    id: DeliveryId,
    createdAt: Date,
    leaseToken: string | null,
    reason: DiscardReason,
    outcome?: DeliveryOutcomeRecord,
  ): Promise<boolean> {
    let query = this.db
      .updateTable('pipeline_delivery')
      .set({
        status: 'DISCARDED',
        discard_reason: reason,
        ...(outcome === undefined ? {} : this.outcomeColumns(outcome)),
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('created_at', '=', createdAt);

    // Sem lease: caminho de "destino sumiu do YAML", em que nao houve claim.
    query = leaseToken === null ? query : query.where('lease_token', '=', leaseToken);

    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  private outcomeColumns(outcome: DeliveryOutcomeRecord) {
    const requestBody = truncateBody(outcome.requestBody, outcome.persistBody, MAX_REQUEST_BODY);
    return {
      response_status: outcome.responseStatus ?? null,
      response_body: truncateBody(outcome.responseBody, outcome.persistBody, MAX_RESPONSE_BODY),
      response_headers:
        outcome.responseHeaders === undefined ? null : JSON.stringify(outcome.responseHeaders),
      request_body: requestBody,
      request_body_bytes: outcome.requestBodyBytes ?? null,
      request_body_sha256:
        outcome.requestBodySha256 ??
        (outcome.requestBody === undefined ? null : sha256Hex(outcome.requestBody)),
      error_code: outcome.errorCode ?? null,
      error_message: outcome.errorMessage?.slice(0, 2_000) ?? null,
      duration_ms: outcome.durationMs,
    };
  }

  async findDrainCandidates(q: {
    graceSeconds: number;
    lookbackDays: number;
    limit: number;
  }): Promise<readonly DrainCandidate[]> {
    const result = await sql<{
      id: string;
      created_at: Date;
      pipeline_id: string;
      destination_id: string;
      enqueue_seq: number;
      max_attempts: number;
      attempt_count: number;
    }>`
      SELECT id, created_at, pipeline_id, destination_id, enqueue_seq, max_attempts, attempt_count
        FROM pipeline_delivery
       WHERE status IN ('PENDING','FAILED')
         -- Grace: um job legitimamente delayed tem next_attempt_at no futuro e
         -- fica invisivel aqui. Sem isto o drenador brigaria com o backoff.
         AND next_attempt_at <= now() - make_interval(secs => ${q.graceSeconds})
         -- Recorte de particao. A consulta do drenador e inerentemente
         -- cross-partition; sem isto sao N probes por ciclo, crescendo sempre.
         AND created_at > now() - make_interval(days => ${q.lookbackDays})
       ORDER BY next_attempt_at
       LIMIT ${q.limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: asDeliveryId(row.id),
      createdAt: row.created_at,
      pipelineId: asPipelineId(row.pipeline_id),
      destinationId: asDestinationId(row.destination_id),
      enqueueSeq: row.enqueue_seq,
      maxAttempts: row.max_attempts,
      attemptCount: row.attempt_count,
    }));
  }

  async bumpEnqueueSeq(id: DeliveryId, createdAt: Date): Promise<number> {
    const result = await sql<{ enqueue_seq: number }>`
      UPDATE pipeline_delivery
         SET enqueue_seq = enqueue_seq + 1, updated_at = now()
       WHERE id = ${id}::uuid AND created_at = ${createdAt}
      RETURNING enqueue_seq
    `.execute(this.db);
    return result.rows[0]?.enqueue_seq ?? 0;
  }

  async markDrained(refs: readonly { id: DeliveryId; createdAt: Date }[]): Promise<void> {
    if (refs.length === 0) return;
    await this.db
      .updateTable('pipeline_delivery')
      .set({ drain_count: sql`drain_count + 1`, last_drained_at: new Date() })
      .where(
        'id',
        'in',
        refs.map((r) => r.id),
      )
      .execute();
  }

  /**
   * Reaper de IN_FLIGHT orfao: instancia que morreu entre o claim e a resposta.
   *
   * A tentativa NAO e devolvida -- attempt_count ja foi incrementado no claim e
   * fica incrementado. E o preco de nao ter laco infinito com payload venenoso.
   */
  async reapExpiredLeases(q: { lookbackDays: number; limit: number }): Promise<ReapSummary> {
    const result = await sql<{ status: DeliveryStatus }>`
      WITH orfas AS (
        SELECT id, created_at
          FROM pipeline_delivery
         WHERE status = 'IN_FLIGHT'
           AND lease_expires_at < now()
           AND created_at > now() - make_interval(days => ${q.lookbackDays})
         ORDER BY lease_expires_at
         LIMIT ${q.limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE pipeline_delivery d
         SET status = CASE WHEN d.attempt_count >= d.max_attempts THEN 'DISCARDED' ELSE 'FAILED' END,
             discard_reason = CASE WHEN d.attempt_count >= d.max_attempts THEN 'ATTEMPTS_EXHAUSTED' END,
             error_code    = coalesce(d.error_code, 'LEASE_EXPIRED'),
             error_message = coalesce(d.error_message, 'worker morreu ou travou durante a entrega'),
             next_attempt_at = now(),
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        FROM orfas o
       WHERE d.id = o.id AND d.created_at = o.created_at
         AND d.status = 'IN_FLIGHT' AND d.lease_expires_at < now()
      RETURNING d.status
    `.execute(this.db);

    let failed = 0;
    let discarded = 0;
    for (const row of result.rows) {
      if (row.status === 'DISCARDED') discarded += 1;
      else failed += 1;
    }
    return { failed, discarded };
  }

  async findByDedupeKey(
    pipelineId: PipelineId,
    key: DedupeKey,
  ): Promise<readonly ClaimedDelivery[]> {
    const rows = await this.db
      .selectFrom('pipeline_delivery')
      .select([
        'id',
        'created_at',
        'pipeline_id',
        'destination_id',
        'event_id',
        'attempt_count',
        'max_attempts',
        'enqueue_seq',
      ])
      .where('pipeline_id', '=', pipelineId)
      .where('dedupe_key', '=', key)
      .execute();

    return rows.map((row) => ({
      id: asDeliveryId(row.id),
      createdAt: row.created_at,
      pipelineId: asPipelineId(row.pipeline_id),
      destinationId: asDestinationId(row.destination_id),
      eventId: asEventId(row.event_id),
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      enqueueSeq: row.enqueue_seq,
    }));
  }

  async countByStatus(pipelineId: PipelineId): Promise<Readonly<Record<DeliveryStatus, number>>> {
    const rows = await this.db
      .selectFrom('pipeline_delivery')
      .select(['status', (eb) => eb.fn.countAll<number>().as('total')])
      .where('pipeline_id', '=', pipelineId)
      .groupBy('status')
      .execute();

    const counts: Record<DeliveryStatus, number> = {
      PENDING: 0,
      IN_FLIGHT: 0,
      DELIVERED: 0,
      FAILED: 0,
      DISCARDED: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  }
}
