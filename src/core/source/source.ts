import type { Clock } from '../ports/clock';
import type { RunStore, StartRunInput } from '../ports/run-store';
import type { RawBatch, RunRef } from '../types/event';
import type { LoggableError, Masked } from '../types/masked';
import type { CompiledPipeline } from '../types/pipeline';

export interface CollectContext {
  readonly pipeline: CompiledPipeline;
  readonly clock: Clock;
  readonly runs: RunStore;
  /** A fonte abre a linha de auditoria porque so ela sabe o que e uma "unidade
   *  de entrada": uma pagina consultada, ou uma requisicao recebida. */
  beginRun(input: Omit<StartRunInput, 'pipelineId'>): Promise<RunRef>;
  failRun(ref: RunRef, error: Masked<LoggableError>, durationMs: number): Promise<void>;
}

/**
 * O UNICO ponto de variacao entre poll e endpoint.
 *
 * O poll rende N paginas, o endpoint rende exatamente um lote, e quem consome
 * nao distingue: `run()` recebe `Source`, nao a uniao dos dois tipos concretos,
 * entao o `kind` sequer esta acessivel la dentro sem um cast.
 */
export interface Source {
  collect(ctx: CollectContext): AsyncIterable<RawBatch>;
}
