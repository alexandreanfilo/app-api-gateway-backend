import type { RunRef } from '../types/event';
import type { PipelineId } from '../types/ids';
import type { LoggableError, Masked } from '../types/masked';

export const RUN_STORE = Symbol('RunStore');

export type RunTrigger = 'POLL' | 'ENDPOINT' | 'MANUAL';
export type RunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'ERROR';

export type { RunRef };

export interface StartRunInput {
  readonly pipelineId: PipelineId;
  readonly trigger: RunTrigger;
  readonly runGroupId?: string;
  /** URL ja resolvida e SEM credencial: o tipo obriga a passar pelo redator. */
  readonly requestUrl?: Masked<string>;
  readonly requestPage?: number;
  readonly sourceIp?: string;
  readonly bodyBytes?: number;
  readonly contentType?: string;
  readonly traceId?: string;
}

export interface RunCounts {
  readonly itemsReceived: number;
  readonly itemsFilteredOut: number;
  readonly itemsDuplicate: number;
  readonly itemsNew: number;
  readonly deliveriesCreated: number;
  readonly httpStatus?: number;
  readonly totalRecordCount?: number;
}

export interface RunStore {
  start(input: StartRunInput): Promise<RunRef>;
  finish(
    ref: RunRef,
    status: RunStatus,
    counts: RunCounts,
    durationMs: number,
    error?: Masked<LoggableError>,
    tx?: unknown,
  ): Promise<void>;
  purgeExpired(): Promise<void>;
}
