export const UNIT_OF_WORK = Symbol('UnitOfWork');

/**
 * O fan-out das entregas roda na MESMA transacao do insert dos eventos. Sem
 * isso, uma queda entre as duas escritas deixa evento sem entrega -- e o evento,
 * ja deduplicado, nunca mais seria reprocessado.
 *
 * O `tx` e opaco para o core de proposito: ele nao pode saber que existe Kysely
 * do outro lado.
 */
export interface UnitOfWork {
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}
