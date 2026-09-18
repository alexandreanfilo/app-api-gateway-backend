import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { IdGenerator } from '../../core/ports/id-generator';
import { ID_GENERATOR } from '../../core/ports/id-generator';
import type { RunCounts, RunStatus, RunStore, StartRunInput } from '../../core/ports/run-store';
import type { RunRef } from '../../core/types/event';
import { asRunId } from '../../core/types/ids';
import type { LoggableError, Masked } from '../../core/types/masked';
import { DATABASE, type Db } from '../database';
import {
  DEFAULT_PERSISTENCE_OPTIONS,
  PERSISTENCE_OPTIONS,
  type PersistenceOptions,
} from '../persistence.tokens';
import { executor, withPartitionRecovery } from './support';

@Injectable()
export class PipelineRunRepository implements RunStore {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PERSISTENCE_OPTIONS)
    private readonly options: PersistenceOptions = DEFAULT_PERSISTENCE_OPTIONS,
  ) {}

  async start(input: StartRunInput): Promise<RunRef> {
    const createdAt = new Date();
    const id = this.ids.uuidV7(createdAt);

    await withPartitionRecovery(
      this.db,
      'pipeline_run',
      this.options.partitionMonthsAhead,
      async () => {
        await this.db
          .insertInto('pipeline_run')
          .values({
            id,
            created_at: createdAt,
            pipeline_id: input.pipelineId,
            run_group_id: input.runGroupId ?? null,
            trigger: input.trigger,
            status: 'RUNNING',
            request_url: input.requestUrl ?? null,
            request_page: input.requestPage ?? null,
            source_ip: input.sourceIp ?? null,
            body_bytes: input.bodyBytes ?? null,
            content_type: input.contentType ?? null,
            trace_id: input.traceId ?? null,
          })
          .execute();
      },
      this.options.onPartitionRecovered,
    );

    return { id: asRunId(id), createdAt };
  }

  async finish(
    ref: RunRef,
    status: RunStatus,
    counts: RunCounts,
    durationMs: number,
    error?: Masked<LoggableError>,
    tx?: unknown,
  ): Promise<void> {
    const db = executor(this.db, tx);
    await db
      .updateTable('pipeline_run')
      .set({
        status,
        items_received: counts.itemsReceived,
        items_filtered_out: counts.itemsFilteredOut,
        items_duplicate: counts.itemsDuplicate,
        items_new: counts.itemsNew,
        deliveries_created: counts.deliveriesCreated,
        http_status: counts.httpStatus ?? null,
        total_record_count: counts.totalRecordCount ?? null,
        duration_ms: durationMs,
        error_code: error?.code ?? (error === undefined ? null : error.name),
        // A mensagem ja chega mascarada: o tipo Masked<LoggableError> e o que
        // impede alguem de passar o erro cru com headers dentro.
        error_message: error === undefined ? null : error.message.slice(0, 2_000),
        finished_at: new Date(),
      })
      .where('id', '=', ref.id)
      .where('created_at', '=', ref.createdAt)
      .execute();
  }

  /** DROP de particao e O(1); DELETE de milhoes de linhas compete com a ingestao. */
  async purgeExpired(): Promise<void> {
    await sql`
      SELECT gw_drop_old_partitions(table_name, keep_months) FROM gw_partition_policy
    `.execute(this.db);
  }
}
