/**
 * Tipos marcados. O compilador recusa passar um pipelineId onde se espera um
 * eventId, o que em um sistema cujas chaves sao todas `string` deixa de ser
 * preciosismo e passa a ser a unica defesa.
 */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type PipelineId = Brand<string, 'PipelineId'>;
export type DestinationId = Brand<string, 'DestinationId'>;
export type EventId = Brand<string, 'EventId'>;
export type RunId = Brand<string, 'RunId'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type DedupeKey = Brand<string, 'DedupeKey'>;

export const asPipelineId = (v: string): PipelineId => v as PipelineId;
export const asDestinationId = (v: string): DestinationId => v as DestinationId;
export const asEventId = (v: string): EventId => v as EventId;
export const asRunId = (v: string): RunId => v as RunId;
export const asDeliveryId = (v: string): DeliveryId => v as DeliveryId;
export const asDedupeKey = (v: string): DedupeKey => v as DedupeKey;
