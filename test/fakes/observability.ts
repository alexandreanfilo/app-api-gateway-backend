import type { Logger } from '../../src/core/ports/logger';
import type { MetricAttributes, Metrics } from '../../src/core/ports/metrics';
import type { SpanHandle, Tracing } from '../../src/core/ports/tracing';

export class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string }[] = [];
  private push(level: string, message: string): void {
    this.lines.push({ level, message });
  }
  debug(m: string): void {
    this.push('debug', m);
  }
  info(m: string): void {
    this.push('info', m);
  }
  warn(m: string): void {
    this.push('warn', m);
  }
  error(m: string): void {
    this.push('error', m);
  }
  fatal(m: string): void {
    this.push('fatal', m);
  }
}

export class RecordingMetrics implements Metrics {
  readonly calls: { name: string; value: number; attrs: MetricAttributes }[] = [];
  private record(name: string, value: number, attrs: MetricAttributes): void {
    this.calls.push({ name, value, attrs });
  }
  total(name: string): number {
    return this.calls.filter((c) => c.name === name).reduce((sum, c) => sum + c.value, 0);
  }
  itemsReceived(n: number, a: MetricAttributes): void {
    this.record('itemsReceived', n, a);
  }
  itemsFiltered(n: number, a: MetricAttributes): void {
    this.record('itemsFiltered', n, a);
  }
  itemsDeduplicated(n: number, a: MetricAttributes): void {
    this.record('itemsDeduplicated', n, a);
  }
  itemsAccepted(n: number, a: MetricAttributes): void {
    this.record('itemsAccepted', n, a);
  }
  ingressRejected(n: number, a: MetricAttributes): void {
    this.record('ingressRejected', n, a);
  }
  deliveryFinished(n: number, a: MetricAttributes): void {
    this.record('deliveryFinished', n, a);
  }
  deliveryDuration(n: number, a: MetricAttributes): void {
    this.record('deliveryDuration', n, a);
  }
  duplicateDeliveryDetected(n: number, a: MetricAttributes): void {
    this.record('duplicateDeliveryDetected', n, a);
  }
  drainResurrected(n: number, a: MetricAttributes): void {
    this.record('drainResurrected', n, a);
  }
  collectSkipped(n: number, a: MetricAttributes): void {
    this.record('collectSkipped', n, a);
  }
  pollPageItems(n: number, a: MetricAttributes): void {
    this.record('pollPageItems', n, a);
  }
  pollDuration(n: number, a: MetricAttributes): void {
    this.record('pollDuration', n, a);
  }
  inboundBodySize(n: number, a: MetricAttributes): void {
    this.record('inboundBodySize', n, a);
  }
  tokenRefresh(n: number, a: MetricAttributes): void {
    this.record('tokenRefresh', n, a);
  }
  defaultPartitionRows(n: number, a: MetricAttributes): void {
    this.record('defaultPartitionRows', n, a);
  }
}

export class PassthroughTracing implements Tracing {
  async withSpan<T>(
    _name: string,
    _attrs: Readonly<Record<string, string | number | boolean>>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return fn({ setAttribute: () => undefined });
  }
  currentTraceId(): string | undefined {
    return undefined;
  }
}
