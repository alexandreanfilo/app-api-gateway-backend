import type { DeliveryId } from '../types/ids';

/**
 * jobId deterministico: primeira camada de deduplicacao. `queue.add()` com um id
 * que ja existe no Redis EM QUALQUER ESTADO e no-op e nao reinicia o delay --
 * entao o proprio Redis e a trava que impede o drenador de duplicar um job que
 * a fila ja tem agendado.
 *
 * O `seq` (enqueue_seq) existe por causa de uma consequencia nao obvia de manter
 * jobs falhados na fila: quando uma entrega esgota as tentativas, o job fica no
 * set `failed` COM AQUELE ID, para sempre. Sem o contador de encarnacao, um
 * replay ou um resgate do drenador chamaria add() com o mesmo id, receberia o
 * no-op silencioso, e a linha ficaria PENDING para sempre enquanto o log diz
 * que foi reenfileirada.
 */
export function deliveryJobId(deliveryId: DeliveryId, enqueueSeq: number): string {
  return `d:${deliveryId}:${enqueueSeq}`;
}
