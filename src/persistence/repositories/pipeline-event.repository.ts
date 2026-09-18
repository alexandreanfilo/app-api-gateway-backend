import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { DedupeResult, EventStore, NewEventInput } from '../../core/ports/event-store';
import type { IdGenerator } from '../../core/ports/id-generator';
import { ID_GENERATOR } from '../../core/ports/id-generator';
import { canonicalize } from '../../core/steps/canonical';
import type { PersistedEvent } from '../../core/types/event';
import {
  asDedupeKey,
  asEventId,
  type DedupeKey,
  type EventId,
  type PipelineId,
} from '../../core/types/ids';
import type { JsonObject } from '../../core/types/json';
import { DATABASE, type Db } from '../database';
import type { NewEventRow } from '../schema';
import { chunked, executor } from './support';

@Injectable()
export class PipelineEventRepository implements EventStore {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Dedupe em lote: INSERT ... ON CONFLICT DO NOTHING RETURNING.
   *
   * Com DO NOTHING, o RETURNING devolve EXATAMENTE as linhas inseridas -- entao
   * o resultado JA E a lista de novos, sem SELECT previo e sem corrida.
   * SELECT-entao-INSERT tem corrida real entre dois workers e entre worker e
   * requisicao HTTP simultaneos: sob concorrencia, duplicatas passam.
   */
  async insertNewOnly(items: readonly NewEventInput[], tx?: unknown): Promise<DedupeResult> {
    const db = executor(this.db, tx);

    // 1) Deduplicar EM MEMORIA antes. ON CONFLICT nao resolve duplicata dentro
    //    do proprio comando de forma util, e a contagem de "novos" sairia errada.
    const byKey = new Map<string, NewEventInput>();
    for (const item of items) if (!byKey.has(item.dedupeKey)) byKey.set(item.dedupeKey, item);

    // 2) ORDENAR por dedupe_key. Nao e supersticao: dois pods recebendo o mesmo
    //    webhook retransmitido, com lotes grandes em ordens diferentes, entram
    //    em deadlock no indice unico. Ordenar transforma deadlock em espera.
    const unique = [...byKey.values()].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1));

    const inserted: PersistedEvent[] = [];
    for (const chunk of chunked(unique)) {
      const rows = chunk.map((item) => this.toRow(item));
      const returned = await db
        .insertInto('pipeline_event')
        .values(rows)
        .onConflict((oc) => oc.columns(['pipeline_id', 'dedupe_key']).doNothing())
        .returning(['id', 'created_at', 'dedupe_key'])
        .execute();

      for (const row of returned) {
        inserted.push({
          id: asEventId(row.id),
          createdAt: row.created_at,
          dedupeKey: asDedupeKey(row.dedupe_key),
        });
      }
    }

    const newKeys = new Set(inserted.map((event) => event.dedupeKey as string));
    return {
      inserted,
      duplicateKeys: unique
        .filter((item) => !newKeys.has(item.dedupeKey))
        .map((item) => item.dedupeKey),
      receivedCount: items.length,
      intraBatchDupes: items.length - unique.length,
    };
  }

  private toRow(item: NewEventInput): NewEventRow {
    const createdAt = item.runCreatedAt;
    const payload = canonicalize(item.payload);
    return {
      id: this.ids.uuidV7(createdAt),
      created_at: createdAt,
      pipeline_id: item.pipelineId,
      dedupe_key: item.dedupeKey,
      dedupe_source: item.dedupeSource.slice(0, 500),
      run_id: item.runId,
      run_created_at: item.runCreatedAt,
      occurred_at: item.occurredAt ?? null,
      payload,
      payload_bytes: Buffer.byteLength(payload, 'utf8'),
    };
  }

  async findByDedupeKey(
    pipelineId: PipelineId,
    key: DedupeKey,
  ): Promise<PersistedEvent | undefined> {
    const row = await this.db
      .selectFrom('pipeline_event')
      .select(['id', 'created_at', 'dedupe_key'])
      .where('pipeline_id', '=', pipelineId)
      .where('dedupe_key', '=', key)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: asEventId(row.id),
          createdAt: row.created_at,
          dedupeKey: asDedupeKey(row.dedupe_key),
        };
  }

  async findManyByDedupeKey(
    pipelineId: PipelineId,
    keys: readonly DedupeKey[],
    tx?: unknown,
  ): Promise<readonly PersistedEvent[]> {
    if (keys.length === 0) return [];
    const db = executor(this.db, tx);
    const rows = await db
      .selectFrom('pipeline_event')
      .select(['id', 'created_at', 'dedupe_key'])
      .where('pipeline_id', '=', pipelineId)
      .where('dedupe_key', 'in', [...keys])
      .execute();
    return rows.map((row) => ({
      id: asEventId(row.id),
      createdAt: row.created_at,
      dedupeKey: asDedupeKey(row.dedupe_key),
    }));
  }

  async payloadOf(eventId: EventId): Promise<JsonObject | undefined> {
    const row = await this.db
      .selectFrom('pipeline_event')
      .select('payload')
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as JsonObject;
  }

  /**
   * Apagar um evento faz o item VOLTAR A PARECER NOVO. Se o poll consulta uma
   * API que devolve os ultimos 30 dias e a purga corta em 15, tudo e reentregue.
   *
   * Duas guardas, ambas necessarias: a janela nunca pode ser menor que a
   * configurada no YAML (checado por quem chama), e nenhum evento com entrega
   * nao terminal e apagado.
   */
  async purgeOlderThan(days: number, batchSize: number): Promise<number> {
    const result = await sql<{ id: string }>`
      WITH vitimas AS (
        SELECT id, created_at FROM pipeline_event
         WHERE created_at < now() - make_interval(days => ${days})
         ORDER BY created_at
         LIMIT ${batchSize}
      )
      DELETE FROM pipeline_event e
       USING vitimas v
       WHERE e.id = v.id
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_delivery d
            WHERE d.event_id = e.id
              -- Recorte obrigatorio: sem ele o NOT EXISTS varre TODAS as
              -- particoes de pipeline_delivery a cada lote. Como a entrega nasce
              -- com o created_at do evento, a poda e exata.
              AND d.created_at >= v.created_at
              AND d.created_at <  v.created_at + interval '1 day'
              AND d.status IN ('PENDING','FAILED','IN_FLIGHT')
         )
      RETURNING e.id
    `.execute(this.db);
    return result.rows.length;
  }
}
