import type { DeliveryId, DestinationId, PipelineId } from '../types/ids';

export const DELIVERY_QUEUE = Symbol('DeliveryQueue');

/**
 * O job carrega PONTEIRO, nunca payload. Dois motivos: job.data vai para o Redis
 * em JSON legivel por qualquer um com acesso ao Redis; e o corpo e renderizado
 * na hora do envio, o que faz corrigir o transform no YAML consertar as
 * retentativas pendentes sem replay.
 */
export interface DeliveryJobData {
  readonly deliveryId: DeliveryId;
  readonly createdAt: string;
  readonly pipelineId: PipelineId;
  readonly destinationId: DestinationId;
}

export interface EnqueueSpec {
  readonly data: DeliveryJobData;
  readonly jobId: string;
  readonly attempts: number;
  readonly delayMs: number;
}

export interface DeliveryQueue {
  enqueueMany(specs: readonly EnqueueSpec[]): Promise<void>;
  /** Estado do job daquela encarnacao, para o drenador nao colidir com a fila. */
  jobState(jobId: string): Promise<'alive' | 'terminal' | 'absent'>;
  isEmpty(): Promise<boolean>;
}
