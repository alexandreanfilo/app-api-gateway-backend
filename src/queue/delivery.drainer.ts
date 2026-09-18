import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DELIVERY_QUEUE, type DeliveryQueue, type EnqueueSpec } from '../core/ports/delivery-queue';
import { DELIVERY_STORE, type DeliveryStore } from '../core/ports/delivery-store';
import { LOGGER, type Logger } from '../core/ports/logger';
import { METRICS, type Metrics } from '../core/ports/metrics';
import { PIPELINE_LOCK, type PipelineLock, SKIPPED } from '../core/ports/pipeline-lock';
import { alreadySafe, maskError } from '../core/redaction/mask';
import { deliveryJobId } from '../core/runner/job-id';
import { GATEWAY_RUNTIME, type RuntimeConfig } from '../runtime.tokens';

/**
 * A verdade sobre o que falta entregar esta no Postgres, nao no Redis.
 *
 * Perder o Redis deve custar ATRASO, nao evento: este drenador reconstroi a
 * fila a partir das linhas PENDING/FAILED. E tambem por causa dele que o 202 do
 * endpoint pode ser respondido antes de o enfileiramento dar certo.
 */
@Injectable()
export class DeliveryDrainer {
  constructor(
    @Inject(DELIVERY_STORE) private readonly deliveries: DeliveryStore,
    @Inject(DELIVERY_QUEUE) private readonly queue: DeliveryQueue,
    @Inject(PIPELINE_LOCK) private readonly locks: PipelineLock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(GATEWAY_RUNTIME) private readonly runtime: RuntimeConfig,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'delivery-drainer' })
  async tick(): Promise<void> {
    try {
      // @Cron dispara em toda instancia; um drenador basta.
      const result = await this.locks.withLock('delivery-drainer', async () => {
        await this.reap();
        return this.drain();
      });
      if (result !== SKIPPED && result > 0) {
        this.logger.info('drenador reenfileirou entregas', alreadySafe({ resgatadas: result }));
      }
    } catch (error) {
      this.logger.error('ciclo do drenador falhou', maskError(error));
    }
  }

  /**
   * Reaper primeiro: uma entrega IN_FLIGHT orfa (instancia morta no meio da
   * chamada HTTP) precisa voltar a FAILED antes de o drenador procurar
   * candidatos, senao ela so seria resgatada no ciclo seguinte.
   */
  private async reap(): Promise<void> {
    const summary = await this.deliveries.reapExpiredLeases({
      lookbackDays: this.runtime.drainLookbackDays,
      limit: this.runtime.drainBatchSize,
    });
    if (summary.failed + summary.discarded > 0) {
      this.logger.warn(
        'entregas com lease expirado recuperadas',
        alreadySafe({ paraNovaTentativa: summary.failed, descartadas: summary.discarded }),
      );
    }
  }

  private async drain(): Promise<number> {
    let total = 0;

    for (let round = 0; round < 10; round++) {
      const candidates = await this.deliveries.findDrainCandidates({
        graceSeconds: this.runtime.drainGraceSeconds,
        lookbackDays: this.runtime.drainLookbackDays,
        limit: this.runtime.drainBatchSize,
      });
      if (candidates.length === 0) break;

      // Reconstrucao a frio: Redis vazio (flush ou failover). Nenhum jobId pode
      // existir, entao nao ha razao para um getJob por linha.
      const coldRebuild = await this.queue.isEmpty();

      const specs: EnqueueSpec[] = [];
      const drained: { id: (typeof candidates)[number]['id']; createdAt: Date }[] = [];

      for (const candidate of candidates) {
        let seq = candidate.enqueueSeq;

        if (!coldRebuild) {
          const state = await this.queue.jobState(deliveryJobId(candidate.id, seq));
          if (state === 'alive') continue; // a fila ja tem o job; nada a fazer
          if (state === 'terminal') {
            // jobId queimado: o job daquela encarnacao ficou no set `failed` e
            // um add() com o mesmo id seria no-op SILENCIOSO -- a linha
            // continuaria PENDING enquanto o log afirmaria que foi resgatada.
            seq = await this.deliveries.bumpEnqueueSeq(candidate.id, candidate.createdAt);
            this.metrics.drainResurrected(1, {
              pipelineId: candidate.pipelineId,
              destinationId: candidate.destinationId,
            });
          }
        }

        specs.push({
          data: {
            deliveryId: candidate.id,
            createdAt: candidate.createdAt.toISOString(),
            pipelineId: candidate.pipelineId,
            destinationId: candidate.destinationId,
          },
          jobId: deliveryJobId(candidate.id, seq),
          attempts: candidate.maxAttempts,
          delayMs: 0,
        });
        drained.push({ id: candidate.id, createdAt: candidate.createdAt });
      }

      if (specs.length > 0) {
        await this.queue.enqueueMany(specs);
        // O drenador NUNCA altera `status`: so marca drain_count. Isso mantem a
        // maquina de estados com dois escritores (worker e reaper) em vez de
        // tres, e e o que torna a colisao drenador x fila inofensiva por
        // construcao, nao por sorte de temporizacao.
        await this.deliveries.markDrained(drained);
        total += specs.length;
      }

      if (candidates.length < this.runtime.drainBatchSize) break;
    }

    return total;
  }
}
