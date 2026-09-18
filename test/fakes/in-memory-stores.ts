import type {
  DeliveryJobData,
  DeliveryQueue,
  EnqueueSpec,
} from '../../src/core/ports/delivery-queue';
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
} from '../../src/core/ports/delivery-store';
import type { DedupeResult, EventStore, NewEventInput } from '../../src/core/ports/event-store';
import type { HttpClient, HttpOutcome, OutboundRequest } from '../../src/core/ports/http-client';
import type { RunCounts, RunStatus, RunStore, StartRunInput } from '../../src/core/ports/run-store';
import type { SecretResolver } from '../../src/core/ports/secret-resolver';
import { SecretUnavailableError } from '../../src/core/ports/secret-resolver';
import type { TokenCache } from '../../src/core/ports/token-cache';
import type { UnitOfWork } from '../../src/core/ports/unit-of-work';
import type { DeliveryRef, PersistedEvent, RunRef } from '../../src/core/types/event';
import {
  asEventId,
  asRunId,
  type DedupeKey,
  type DeliveryId,
  type EventId,
  type PipelineId,
} from '../../src/core/types/ids';
import type { JsonObject } from '../../src/core/types/json';
import { Secret } from '../../src/core/types/secret';
import { SequentialIdGenerator } from './id-generator';

/**
 * Fake do EventStore. Roda a MESMA suite de contrato que o repositorio Kysely
 * (test/contracts/event-store.contract.ts): e isso que garante que os testes de
 * motor que usam este fake estejam testando algo realista, em vez de um
 * simulacro que concorda com o codigo por construcao.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byKey = new Map<string, PersistedEvent & { payload: JsonObject }>();
  private readonly ids = new SequentialIdGenerator();

  async insertNewOnly(items: readonly NewEventInput[]): Promise<DedupeResult> {
    const byKey = new Map<string, NewEventInput>();
    for (const item of items) if (!byKey.has(item.dedupeKey)) byKey.set(item.dedupeKey, item);
    const unique = [...byKey.values()].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1));

    const inserted: PersistedEvent[] = [];
    const duplicateKeys: DedupeKey[] = [];

    for (const item of unique) {
      const composite = `${item.pipelineId}|${item.dedupeKey}`;
      if (this.byKey.has(composite)) {
        duplicateKeys.push(item.dedupeKey);
        continue;
      }
      const event = {
        id: asEventId(this.ids.uuidV7(item.runCreatedAt)),
        createdAt: item.runCreatedAt,
        dedupeKey: item.dedupeKey,
        payload: item.payload,
      };
      this.byKey.set(composite, event);
      inserted.push({ id: event.id, createdAt: event.createdAt, dedupeKey: event.dedupeKey });
    }

    return {
      inserted,
      duplicateKeys,
      receivedCount: items.length,
      intraBatchDupes: items.length - unique.length,
    };
  }

  async findByDedupeKey(
    pipelineId: PipelineId,
    key: DedupeKey,
  ): Promise<PersistedEvent | undefined> {
    return this.byKey.get(`${pipelineId}|${key}`);
  }

  async findManyByDedupeKey(
    pipelineId: PipelineId,
    keys: readonly DedupeKey[],
  ): Promise<readonly PersistedEvent[]> {
    const out: PersistedEvent[] = [];
    for (const key of keys) {
      const found = this.byKey.get(`${pipelineId}|${key}`);
      if (found !== undefined) out.push(found);
    }
    return out;
  }

  async payloadOf(eventId: EventId): Promise<JsonObject | undefined> {
    for (const event of this.byKey.values()) if (event.id === eventId) return event.payload;
    return undefined;
  }

  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const [key, event] of [...this.byKey.entries()]) {
      if (event.createdAt.getTime() < cutoff) {
        this.byKey.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.byKey.size;
  }
}

interface StoredDelivery extends NewDelivery {
  status: DeliveryStatus;
  attemptCount: number;
  enqueueSeq: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  discardReason: DiscardReason | null;
  outcome?: DeliveryOutcomeRecord;
}

export class InMemoryDeliveryStore implements DeliveryStore {
  readonly rows = new Map<string, StoredDelivery>();

  async createMany(rows: readonly NewDelivery[]): Promise<readonly DeliveryRef[]> {
    for (const row of rows) {
      this.rows.set(row.id, {
        ...row,
        status: 'PENDING',
        attemptCount: 0,
        enqueueSeq: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        discardReason: null,
      });
    }
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      destinationId: row.destinationId,
      maxAttempts: row.maxAttempts,
    }));
  }

  async claim(
    id: DeliveryId,
    _createdAt: Date,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<ClaimedDelivery | undefined> {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    if (row.attemptCount >= row.maxAttempts) return undefined;

    const leaseAlive = row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > Date.now();
    const claimable =
      row.status === 'PENDING' ||
      row.status === 'FAILED' ||
      (row.status === 'IN_FLIGHT' && !leaseAlive);
    if (!claimable) return undefined;

    row.status = 'IN_FLIGHT';
    row.attemptCount += 1;
    row.leaseToken = leaseToken;
    row.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

    return {
      id: row.id,
      createdAt: row.createdAt,
      pipelineId: row.pipelineId,
      destinationId: row.destinationId,
      eventId: row.eventId,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      enqueueSeq: row.enqueueSeq,
    };
  }

  async classifyClaimMiss(id: DeliveryId): Promise<ClaimMiss> {
    const row = this.rows.get(id);
    if (row === undefined) return 'NOT_FOUND';
    if (row.status === 'DELIVERED' || row.status === 'DISCARDED') return 'ALREADY_TERMINAL';
    if (row.attemptCount >= row.maxAttempts) return 'ATTEMPTS_EXHAUSTED';
    return 'LEASE_HELD_BY_OTHER';
  }

  private settle(
    id: DeliveryId,
    leaseToken: string | null,
    status: DeliveryStatus,
    outcome?: DeliveryOutcomeRecord,
    reason?: DiscardReason,
  ): boolean {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    if (leaseToken !== null && row.leaseToken !== leaseToken) return false;
    row.status = status;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    if (outcome !== undefined) row.outcome = outcome;
    if (reason !== undefined) row.discardReason = reason;
    return true;
  }

  async markDelivered(
    id: DeliveryId,
    _c: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
  ): Promise<boolean> {
    return this.settle(id, leaseToken, 'DELIVERED', outcome);
  }

  async markFailed(
    id: DeliveryId,
    _c: Date,
    leaseToken: string,
    outcome: DeliveryOutcomeRecord,
    retryInMs: number,
  ): Promise<boolean> {
    const ok = this.settle(id, leaseToken, 'FAILED', outcome);
    const row = this.rows.get(id);
    if (ok && row !== undefined) {
      (row as { nextAttemptAt: Date }).nextAttemptAt = new Date(Date.now() + retryInMs);
    }
    return ok;
  }

  async markDiscarded(
    id: DeliveryId,
    _c: Date,
    leaseToken: string | null,
    reason: DiscardReason,
    outcome?: DeliveryOutcomeRecord,
  ): Promise<boolean> {
    return this.settle(id, leaseToken, 'DISCARDED', outcome, reason);
  }

  async findDrainCandidates(q: { limit: number }): Promise<readonly DrainCandidate[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'PENDING' || row.status === 'FAILED')
      .slice(0, q.limit)
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        pipelineId: row.pipelineId,
        destinationId: row.destinationId,
        enqueueSeq: row.enqueueSeq,
        maxAttempts: row.maxAttempts,
        attemptCount: row.attemptCount,
      }));
  }

  async bumpEnqueueSeq(id: DeliveryId): Promise<number> {
    const row = this.rows.get(id);
    if (row === undefined) return 0;
    row.enqueueSeq += 1;
    return row.enqueueSeq;
  }

  async markDrained(): Promise<void> {
    // sem efeito observavel no fake
  }

  async reapExpiredLeases(): Promise<ReapSummary> {
    let failed = 0;
    let discarded = 0;
    for (const row of this.rows.values()) {
      if (row.status !== 'IN_FLIGHT') continue;
      if (row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > Date.now()) continue;
      if (row.attemptCount >= row.maxAttempts) {
        row.status = 'DISCARDED';
        row.discardReason = 'ATTEMPTS_EXHAUSTED';
        discarded += 1;
      } else {
        row.status = 'FAILED';
        failed += 1;
      }
      row.leaseToken = null;
      row.leaseExpiresAt = null;
    }
    return { failed, discarded };
  }

  async findByDedupeKey(
    pipelineId: PipelineId,
    key: DedupeKey,
  ): Promise<readonly ClaimedDelivery[]> {
    return [...this.rows.values()]
      .filter((row) => row.pipelineId === pipelineId && row.dedupeKey === key)
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        pipelineId: row.pipelineId,
        destinationId: row.destinationId,
        eventId: row.eventId,
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        enqueueSeq: row.enqueueSeq,
      }));
  }

  async countByStatus(pipelineId: PipelineId): Promise<Readonly<Record<DeliveryStatus, number>>> {
    const counts: Record<DeliveryStatus, number> = {
      PENDING: 0,
      IN_FLIGHT: 0,
      DELIVERED: 0,
      FAILED: 0,
      DISCARDED: 0,
    };
    for (const row of this.rows.values()) {
      if (row.pipelineId === pipelineId) counts[row.status] += 1;
    }
    return counts;
  }

  statusOf(id: DeliveryId): DeliveryStatus | undefined {
    return this.rows.get(id)?.status;
  }

  discardReasonOf(id: DeliveryId): DiscardReason | null | undefined {
    return this.rows.get(id)?.discardReason;
  }
}

export class InMemoryRunStore implements RunStore {
  readonly runs: { ref: RunRef; input: StartRunInput; status?: RunStatus; counts?: RunCounts }[] =
    [];
  private counter = 0;

  async start(input: StartRunInput): Promise<RunRef> {
    this.counter += 1;
    const ref = {
      id: asRunId(`00000000-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`),
      createdAt: new Date('2026-09-17T12:00:00.000Z'),
    };
    this.runs.push({ ref, input });
    return ref;
  }

  async finish(ref: RunRef, status: RunStatus, counts: RunCounts): Promise<void> {
    const run = this.runs.find((r) => r.ref.id === ref.id);
    if (run !== undefined) {
      run.status = status;
      run.counts = counts;
    }
  }

  async purgeExpired(): Promise<void> {
    // sem retencao no fake
  }
}

export class InMemoryQueue implements DeliveryQueue {
  readonly enqueued: EnqueueSpec[] = [];
  readonly terminalJobIds = new Set<string>();
  shouldFail = false;

  async enqueueMany(specs: readonly EnqueueSpec[]): Promise<void> {
    if (this.shouldFail) throw new Error('redis fora do ar');
    // jobId deterministico: add() com id existente e no-op, como no BullMQ.
    for (const spec of specs) {
      if (this.enqueued.some((e) => e.jobId === spec.jobId)) continue;
      this.enqueued.push(spec);
    }
  }

  async jobState(jobId: string): Promise<'alive' | 'terminal' | 'absent'> {
    if (this.terminalJobIds.has(jobId)) return 'terminal';
    return this.enqueued.some((e) => e.jobId === jobId) ? 'alive' : 'absent';
  }

  async isEmpty(): Promise<boolean> {
    return this.enqueued.length === 0;
  }

  dataFor(jobId: string): DeliveryJobData | undefined {
    return this.enqueued.find((e) => e.jobId === jobId)?.data;
  }
}

/** Executa direto, sem transacao: o fake nao tem o que atomizar. */
export class DirectUnitOfWork implements UnitOfWork {
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn(undefined);
  }
}

export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly values: Record<string, string>) {}
  async exists(name: string): Promise<boolean> {
    return this.values[name] !== undefined;
  }
  async resolve(name: string): Promise<Secret> {
    const value = this.values[name];
    if (value === undefined) throw new SecretUnavailableError(name, this.describe());
    return new Secret(name, value);
  }
  invalidate(): void {
    // sem cache
  }
  describe(): string {
    return 'segredos de teste';
  }
}

export class InMemoryTokenCache implements TokenCache {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async invalidate(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class RecordingHttpClient implements HttpClient {
  readonly requests: OutboundRequest[] = [];
  constructor(private readonly responder: (req: OutboundRequest) => HttpOutcome) {}

  async send(request: OutboundRequest): Promise<HttpOutcome> {
    this.requests.push(request);
    return this.responder(request);
  }
}

export function jsonResponse(status: number, body: unknown = {}): HttpOutcome {
  return {
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    durationMs: 1,
  };
}
