import type { Clock } from '../ports/clock';
import type { DeliveryQueue, EnqueueSpec } from '../ports/delivery-queue';
import type { DeliveryStore, NewDelivery } from '../ports/delivery-store';
import type { EventStore, NewEventInput } from '../ports/event-store';
import type { IdGenerator } from '../ports/id-generator';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { RunStore } from '../ports/run-store';
import type { Tracing } from '../ports/tracing';
import type { UnitOfWork } from '../ports/unit-of-work';
import { alreadySafe, maskError, maskUrl } from '../redaction/mask';
import type { Source } from '../source/source';
import { stripNulChars } from '../steps/canonical';
import { buildDedupeKey } from '../steps/dedupe';
import { applyFilters, matchesFilter } from '../steps/filter';
import { splitBody } from '../steps/split';
import type {
  IngestResult,
  ItemOutcome,
  KeyedItem,
  PersistedEvent,
  RawBatch,
  RawItem,
  RejectedItem,
} from '../types/event';
import { asDeliveryId, asRunId } from '../types/ids';
import type { JsonObject } from '../types/json';
import type { CompiledPipeline } from '../types/pipeline';
import { deliveryJobId } from './job-id';

export interface EnginePorts {
  readonly events: EventStore;
  readonly deliveries: DeliveryStore;
  readonly runs: RunStore;
  readonly queue: DeliveryQueue;
  readonly uow: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracing: Tracing;
}

interface BatchTally {
  received: number;
  filteredOut: number;
  duplicates: number;
  accepted: number;
  deliveriesCreated: number;
}

/**
 * O motor. Uma funcao, dois chamadores (o controller do endpoint e o processor
 * do cron), e nenhum `if` sobre de onde o item veio.
 *
 * `run` recebe `Source`, nao a uniao dos dois tipos concretos, e
 * `pipeline.downstream` nao tem discriminante: escrever um caminho especifico
 * por tipo de entrada exigiria alterar um tipo publico, o que aparece no diff
 * em vez de acontecer em silencio dentro de um step.
 */
export class PipelineRunner {
  constructor(private readonly ports: EnginePorts) {}

  async run(pipeline: CompiledPipeline, source: Source): Promise<IngestResult> {
    const tally: BatchTally = {
      received: 0,
      filteredOut: 0,
      duplicates: 0,
      accepted: 0,
      deliveriesCreated: 0,
    };
    const outcomes: ItemOutcome[] = [];
    const rejected: RejectedItem[] = [];
    let pages = 0;
    let lastRun: RawBatch['run'] | undefined;
    let enqueued = 0;

    for await (const batch of source.collect({
      pipeline,
      clock: this.ports.clock,
      runs: this.ports.runs,
      beginRun: (input) => this.ports.runs.start({ ...input, pipelineId: pipeline.id }),
      failRun: (ref, error, durationMs) =>
        this.ports.runs.finish(ref, 'ERROR', emptyCounts(), durationMs, error),
    })) {
      pages += 1;
      lastRun = batch.run;
      enqueued += await this.processBatch(pipeline, batch, tally, outcomes, rejected);
    }

    return {
      pipelineId: pipeline.id,
      runId: lastRun?.id ?? asRunId(''),
      received: tally.received,
      filteredOut: tally.filteredOut,
      duplicates: tally.duplicates,
      accepted: tally.accepted,
      deliveriesCreated: tally.deliveriesCreated,
      enqueued,
      pages,
      outcomes,
      rejected,
    };
  }

  private async processBatch(
    pipeline: CompiledPipeline,
    batch: RawBatch,
    tally: BatchTally,
    outcomes: ItemOutcome[],
    rejected: RejectedItem[],
  ): Promise<number> {
    const startedAt = Date.now();
    const { downstream } = pipeline;

    // ---- Splitter -----------------------------------------------------------
    // Antes do filtro, e nao depois: `filter: { status: [NP, LF] }` e uma regra
    // sobre o EVENTO, e o corpo da pagina inteira nao tem `status`. Filtrar
    // antes do split descartaria todo lote de todo pipeline que usa filtro.
    const items: RawItem[] = [];
    for (const document of batch.items) {
      const split = splitBody(downstream.split.itemsPath, document.data);
      if (!split.ok) {
        rejected.push({
          index: document.index,
          reason: split.error.reason,
          detail: split.error.detail,
        });
        continue;
      }
      for (const data of split.value) {
        items.push({ ...document, data: stripNulChars(data) as JsonObject, index: items.length });
      }
    }
    tally.received += items.length;
    this.ports.metrics.itemsReceived(items.length, {
      pipelineId: pipeline.id,
      sourceKind: pipeline.source.kind,
    });

    // ---- Message Filter -----------------------------------------------------
    const kept = applyFilters(downstream.filter)(items);
    const keptIndexes = new Set(kept.map((i) => i.index));
    for (const item of items) {
      if (!keptIndexes.has(item.index)) outcomes.push({ index: item.index, status: 'filtered' });
    }
    const filteredOut = items.length - kept.length;
    tally.filteredOut += filteredOut;
    this.ports.metrics.itemsFiltered(filteredOut, {
      pipelineId: pipeline.id,
      sourceKind: pipeline.source.kind,
    });

    // ---- Chave de deduplicacao ---------------------------------------------
    const makeKey = buildDedupeKey(downstream.dedupe);
    const keyed: KeyedItem[] = [];
    for (const item of kept) {
      const result = makeKey(item);
      if (!result.ok) {
        rejected.push({
          index: item.index,
          reason: 'DEDUPE_KEY_MISSING',
          detail: result.error.detail,
        });
        outcomes.push({ index: item.index, status: 'rejected', reason: result.error.detail });
        continue;
      }
      keyed.push(result.value);
    }

    if (keyed.length === 0) {
      await this.ports.runs.finish(
        batch.run,
        rejected.length > 0 ? 'PARTIAL' : 'SUCCESS',
        countsFor(batch, items.length, filteredOut, 0, 0, 0),
        Date.now() - startedAt,
      );
      return 0;
    }

    // ---- Idempotent Consumer + fan-out, na MESMA transacao ------------------
    const outcome = await this.ports.tracing.withSpan(
      'gateway.dedupe',
      { 'gateway.pipeline.id': pipeline.id, 'gateway.dedupe.keys': keyed.length },
      async (span) => {
        const result = await this.ports.uow.transaction(async (tx) => {
          const inputs: NewEventInput[] = keyed.map((k) => ({
            pipelineId: pipeline.id,
            dedupeKey: k.dedupeKey,
            dedupeSource: k.dedupeSource,
            runId: batch.run.id,
            runCreatedAt: batch.run.createdAt,
            payload: k.item.data,
          }));

          const dedupe = await this.ports.events.insertNewOnly(inputs, tx);

          const existing =
            dedupe.duplicateKeys.length > 0
              ? await this.ports.events.findManyByDedupeKey(pipeline.id, dedupe.duplicateKeys, tx)
              : [];

          // O filtro por destino precisa do ITEM, nao so do evento persistido.
          const dataByKey = new Map(keyed.map((k) => [k.dedupeKey as string, k.item.data]));
          const deliveries = this.fanOut(pipeline, dedupe.inserted, dataByKey);
          if (deliveries.length > 0) await this.ports.deliveries.createMany(deliveries, tx);

          await this.ports.runs.finish(
            batch.run,
            'SUCCESS',
            countsFor(
              batch,
              items.length,
              filteredOut,
              dedupe.duplicateKeys.length,
              dedupe.inserted.length,
              deliveries.length,
            ),
            Date.now() - startedAt,
            undefined,
            tx,
          );

          return { dedupe, existing, deliveries };
        });

        span.setAttribute('gateway.dedupe.claimed', result.dedupe.inserted.length);
        span.setAttribute('gateway.dedupe.duplicates', result.dedupe.duplicateKeys.length);
        return result;
      },
    );

    // ---- Resultado por item -------------------------------------------------
    const byKey = new Map(outcome.dedupe.inserted.map((e) => [e.dedupeKey as string, e]));
    const existingByKey = new Map(outcome.existing.map((e) => [e.dedupeKey as string, e]));
    for (const k of keyed) {
      const inserted = byKey.get(k.dedupeKey);
      if (inserted !== undefined) {
        outcomes.push({ index: k.item.index, status: 'accepted', eventId: inserted.id });
        continue;
      }
      const original = existingByKey.get(k.dedupeKey);
      outcomes.push({
        index: k.item.index,
        status: 'duplicate',
        ...(original !== undefined ? { eventId: original.id } : {}),
      });
    }

    tally.duplicates += outcome.dedupe.duplicateKeys.length;
    tally.accepted += outcome.dedupe.inserted.length;
    tally.deliveriesCreated += outcome.deliveries.length;

    this.ports.metrics.itemsDeduplicated(outcome.dedupe.duplicateKeys.length, {
      pipelineId: pipeline.id,
      sourceKind: pipeline.source.kind,
    });
    this.ports.metrics.itemsAccepted(outcome.dedupe.inserted.length, {
      pipelineId: pipeline.id,
      sourceKind: pipeline.source.kind,
    });

    if (outcome.dedupe.intraBatchDupes > 0) {
      this.ports.logger.warn(
        'lote continha chaves de deduplicacao repetidas',
        alreadySafe({
          pipelineId: pipeline.id,
          intraBatchDupes: outcome.dedupe.intraBatchDupes,
        }),
      );
    }

    // ---- Enfileiramento: DEPOIS do commit ----------------------------------
    return this.enqueue(pipeline, outcome.deliveries);
  }

  /**
   * Recipient List: uma entrega por (evento x destino), com status independente.
   *
   * Um destino com `filter` so entra quando o item casa (Content-Based Router).
   * Avaliar aqui, e nao na entrega, evita criar uma linha em pipeline_delivery
   * que nasceria apenas para ser descartada.
   */
  private fanOut(
    pipeline: CompiledPipeline,
    events: readonly PersistedEvent[],
    dataByKey: ReadonlyMap<string, JsonObject>,
  ): NewDelivery[] {
    const now = this.ports.clock.now();
    const traceId = this.ports.tracing.currentTraceId();
    const rows: NewDelivery[] = [];

    for (const event of events) {
      const data = dataByKey.get(event.dedupeKey);
      for (const destination of pipeline.downstream.destinations) {
        if (
          destination.filter.rules.length > 0 &&
          (data === undefined || !matchesFilter(destination.filter, data))
        ) {
          continue;
        }
        rows.push({
          // created_at da ENTREGA = created_at do EVENTO. Mantem evento e
          // entregas na mesma particao mensal, e faz a busca por dedupe_key
          // podar identicamente nas duas tabelas.
          id: asDeliveryId(this.ports.ids.uuidV7(event.createdAt)),
          createdAt: event.createdAt,
          pipelineId: pipeline.id,
          destinationId: destination.id,
          eventId: event.id,
          dedupeKey: event.dedupeKey,
          maxAttempts: destination.retry.attempts,
          nextAttemptAt: now,
          requestMethod: destination.method,
          requestUrl: maskUrl(destination.url),
          ...(traceId !== undefined ? { traceId } : {}),
        });
      }
    }
    return rows;
  }

  /**
   * Se isto falhar, NADA se perde: as linhas ficam PENDING e o drenador as
   * encontra no proximo ciclo. E por isso que o 202 do endpoint nao depende do
   * Redis estar de pe -- a garantia e a linha no Postgres, a fila e aceleracao.
   */
  private async enqueue(
    pipeline: CompiledPipeline,
    deliveries: readonly NewDelivery[],
  ): Promise<number> {
    if (deliveries.length === 0) return 0;

    const specs: EnqueueSpec[] = deliveries.map((d) => ({
      data: {
        deliveryId: d.id,
        createdAt: d.createdAt.toISOString(),
        pipelineId: d.pipelineId,
        destinationId: d.destinationId,
      },
      jobId: deliveryJobId(d.id, 0),
      attempts: d.maxAttempts,
      delayMs: 0,
    }));

    try {
      await this.ports.queue.enqueueMany(specs);
      return specs.length;
    } catch (error) {
      this.ports.logger.warn(
        'enfileiramento falhou; drenador assume as entregas pendentes',
        alreadySafe({ pipelineId: pipeline.id, count: specs.length, error: maskError(error) }),
      );
      return 0;
    }
  }
}

function emptyCounts() {
  return {
    itemsReceived: 0,
    itemsFilteredOut: 0,
    itemsDuplicate: 0,
    itemsNew: 0,
    deliveriesCreated: 0,
  };
}

function countsFor(
  batch: RawBatch,
  received: number,
  filteredOut: number,
  duplicates: number,
  accepted: number,
  deliveriesCreated: number,
) {
  return {
    itemsReceived: received,
    itemsFilteredOut: filteredOut,
    itemsDuplicate: duplicates,
    itemsNew: accepted,
    deliveriesCreated,
    ...(batch.httpStatus !== undefined ? { httpStatus: batch.httpStatus } : {}),
    ...(batch.totalRecordCount !== undefined ? { totalRecordCount: batch.totalRecordCount } : {}),
  };
}
