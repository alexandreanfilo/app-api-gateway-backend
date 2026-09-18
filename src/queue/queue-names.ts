export const DELIVERY_QUEUE_NAME = 'delivery';
export const POLL_QUEUE_NAME = 'poll';

/**
 * Uma fila de entrega para todos os pipelines, e nao uma por pipeline.
 *
 * O isolamento entre destinos que o briefing exige ja e ESTRUTURAL: existe um
 * job por (evento x destino), entao destinos nunca compartilham contador de
 * tentativas, backoff nem slot. Filas separadas por pipeline acrescentariam
 * apenas isolamento de concorrencia -- util quando um destino lento passar a
 * ocupar todos os workers, e o momento de dividir. Ate la, uma fila mantem o
 * registro estatico e o drenador simples.
 */
export const jobSchedulerId = (pipelineId: string): string => `poll:${pipelineId}`;
