import { Injectable } from '@nestjs/common';
import { type Attributes, type Counter, type Histogram, metrics } from '@opentelemetry/api';
import type { MetricAttributes, Metrics } from '../core/ports/metrics';

const METER_NAME = 'app-api-gateway';

/**
 * Atributos permitidos, e SO eles.
 *
 * Id de evento, CPF/CNPJ, placa e URL completa ficam de fora: cada valor
 * distinto vira uma serie temporal nova, e uma metrica com id de evento como
 * atributo produz uma serie por evento. A cardinalidade explode e o custo do
 * backend de metricas com ela.
 */
function toAttributes(attrs: MetricAttributes): Attributes {
  const out: Attributes = {};
  if (attrs.pipelineId !== undefined) out['gateway.pipeline.id'] = attrs.pipelineId;
  if (attrs.sourceKind !== undefined) out['gateway.source.kind'] = attrs.sourceKind;
  if (attrs.destinationId !== undefined) out['gateway.destination.id'] = attrs.destinationId;
  if (attrs.outcome !== undefined) out.outcome = attrs.outcome;
  if (attrs.reason !== undefined) out.reason = attrs.reason;
  if (attrs.httpStatus !== undefined) out['http.response.status_code'] = attrs.httpStatus;
  if (attrs.queueState !== undefined) out['gateway.queue.state'] = attrs.queueState;
  return out;
}

@Injectable()
export class OtelMetrics implements Metrics {
  private readonly meter = metrics.getMeter(METER_NAME);

  // Instrumentos sao declarados UMA vez: recria-los por chamada e caro e
  // fragmenta as series.
  private readonly counters: Record<string, Counter> = {};
  private readonly histograms: Record<string, Histogram> = {};

  private counter(name: string, description: string, unit = '1'): Counter {
    const existing = this.counters[name];
    if (existing !== undefined) return existing;
    const created = this.meter.createCounter(name, { description, unit });
    this.counters[name] = created;
    return created;
  }

  private histogram(name: string, description: string, unit: string): Histogram {
    const existing = this.histograms[name];
    if (existing !== undefined) return existing;
    const created = this.meter.createHistogram(name, { description, unit });
    this.histograms[name] = created;
    return created;
  }

  itemsReceived(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.items.received', 'itens extraidos da entrada').add(
      n,
      toAttributes(attrs),
    );
  }

  itemsFiltered(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.items.filtered', 'itens descartados pelo filtro').add(
      n,
      toAttributes(attrs),
    );
  }

  itemsDeduplicated(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.items.deduplicated', 'itens ja vistos').add(n, toAttributes(attrs));
  }

  itemsAccepted(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.items.accepted', 'eventos novos gravados').add(n, toAttributes(attrs));
  }

  ingressRejected(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.ingress.rejected', 'requisicoes recusadas na entrada').add(
      n,
      toAttributes(attrs),
    );
  }

  /** outcome=dead e a metrica que paga plantao: evento perdido de verdade. */
  deliveryFinished(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.deliveries', 'entregas finalizadas por desfecho').add(
      n,
      toAttributes(attrs),
    );
  }

  deliveryDuration(ms: number, attrs: MetricAttributes): void {
    this.histogram('gateway.delivery.duration', 'duracao da tentativa de entrega', 'ms').record(
      ms,
      toAttributes(attrs),
    );
  }

  duplicateDeliveryDetected(n: number, attrs: MetricAttributes): void {
    this.counter(
      'gateway.delivery.duplicate_detected',
      'entrega duplicada detectada pelo fencing do lease',
    ).add(n, toAttributes(attrs));
  }

  drainResurrected(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.drain.resurrected', 'entregas reenfileiradas pelo drenador').add(
      n,
      toAttributes(attrs),
    );
  }

  collectSkipped(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.collect.skipped', 'coletas puladas por lock de outra instancia').add(
      n,
      toAttributes(attrs),
    );
  }

  pollPageItems(n: number, attrs: MetricAttributes): void {
    this.histogram('gateway.poll.page.items', 'itens por pagina coletada', '{item}').record(
      n,
      toAttributes(attrs),
    );
  }

  pollDuration(ms: number, attrs: MetricAttributes): void {
    this.histogram('gateway.poll.duration', 'duracao de um ciclo de coleta', 'ms').record(
      ms,
      toAttributes(attrs),
    );
  }

  inboundBodySize(bytes: number, attrs: MetricAttributes): void {
    this.histogram('gateway.ingress.body.size', 'tamanho do corpo recebido', 'By').record(
      bytes,
      toAttributes(attrs),
    );
  }

  tokenRefresh(n: number, attrs: MetricAttributes): void {
    this.counter('gateway.auth.token_refresh', 'renovacoes de token login-token').add(
      n,
      toAttributes(attrs),
    );
  }

  defaultPartitionRows(n: number, attrs: MetricAttributes): void {
    this.histogram(
      'gateway.partition.default_rows',
      'linhas na particao DEFAULT: deve ser sempre zero',
      '{row}',
    ).record(n, toAttributes(attrs));
  }
}
