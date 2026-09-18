export const METRICS = Symbol('Metrics');

/**
 * Atributos permitidos, e so eles. Id de evento, CPF/CNPJ, placa e URL completa
 * ficam de fora: cardinalidade explode e o custo do backend de metricas com ela.
 */
export interface MetricAttributes {
  readonly pipelineId?: string;
  readonly sourceKind?: string;
  readonly destinationId?: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly queueState?: string;
}

export interface Metrics {
  itemsReceived(n: number, attrs: MetricAttributes): void;
  itemsFiltered(n: number, attrs: MetricAttributes): void;
  itemsDeduplicated(n: number, attrs: MetricAttributes): void;
  itemsAccepted(n: number, attrs: MetricAttributes): void;
  ingressRejected(n: number, attrs: MetricAttributes): void;
  deliveryFinished(n: number, attrs: MetricAttributes): void;
  deliveryDuration(ms: number, attrs: MetricAttributes): void;
  duplicateDeliveryDetected(n: number, attrs: MetricAttributes): void;
  drainResurrected(n: number, attrs: MetricAttributes): void;
  collectSkipped(n: number, attrs: MetricAttributes): void;
  pollPageItems(n: number, attrs: MetricAttributes): void;
  pollDuration(ms: number, attrs: MetricAttributes): void;
  inboundBodySize(bytes: number, attrs: MetricAttributes): void;
  tokenRefresh(n: number, attrs: MetricAttributes): void;
  defaultPartitionRows(n: number, attrs: MetricAttributes): void;
}
