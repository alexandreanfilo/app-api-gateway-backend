import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DeliveryJobData, DeliveryQueue, EnqueueSpec } from '../core/ports/delivery-queue';
import { type JobEnvelope, seal } from './otel-envelope';
import { DELIVERY_QUEUE_NAME } from './queue-names';

const ALIVE_STATES = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'prioritized']);

/**
 * `removeOnFail` NUNCA e `true` -- job falhado permanece na fila para inspecao.
 *
 * Mas tambem nao e `false` literal, e isso e deliberado: `false` e ilimitado, e
 * a 1,7M entregas/dia com 1% de falha permanente sao 17k jobs/dia acumulando no
 * set `failed`. O BullMQ exige Redis em maxmemory-policy noeviction (senao ele
 * descarta jobs em silencio), entao "guardar tudo para sempre" termina com o
 * Redis cheio e a fila parada. A evidencia canonica da falha esta no Postgres,
 * que e justamente o ponto: reter uma semana no Redis respeita a regra e
 * corrige o efeito colateral.
 */
export const DELIVERY_JOB_OPTIONS = {
  removeOnComplete: { age: 3_600, count: 20_000 },
  removeOnFail: { age: 604_800, count: 100_000 },
} as const;

@Injectable()
export class BullDeliveryQueue implements DeliveryQueue {
  constructor(@InjectQueue(DELIVERY_QUEUE_NAME) private readonly queue: Queue) {}

  async enqueueMany(specs: readonly EnqueueSpec[]): Promise<void> {
    if (specs.length === 0) return;
    await this.queue.addBulk(
      specs.map((spec) => ({
        name: 'deliver',
        data: seal(spec.data) as JobEnvelope<DeliveryJobData>,
        opts: {
          // jobId deterministico: add() com id existente e no-op e NAO reinicia
          // o delay -- o Redis e ele proprio a trava contra o drenador.
          jobId: spec.jobId,
          attempts: spec.attempts,
          backoff: { type: 'gateway' },
          delay: spec.delayMs > 0 ? spec.delayMs : 0,
          ...DELIVERY_JOB_OPTIONS,
        },
      })),
    );
  }

  async jobState(jobId: string): Promise<'alive' | 'terminal' | 'absent'> {
    const job = await this.queue.getJob(jobId);
    if (job === undefined) return 'absent';
    const state = await job.getState();
    if (ALIVE_STATES.has(state)) return 'alive';
    return state === 'failed' || state === 'completed' ? 'terminal' : 'absent';
  }

  /** Redis vazio (flush/failover): o drenador pula o getJob linha a linha. */
  async isEmpty(): Promise<boolean> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return Object.values(counts).every((count) => count === 0);
  }
}
