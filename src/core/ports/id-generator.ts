export const ID_GENERATOR = Symbol('IdGenerator');

/**
 * UUIDv7, nao v4: ordenavel no tempo, entao os inserts caem na cauda do btree
 * em vez de espalhar page splits pela maior tabela do sistema.
 *
 * Recebe o instante porque o id e o created_at precisam ser o MESMO instante:
 * gerar o id em T e deixar o banco preencher now() pode jogar os dois em lados
 * opostos de uma virada de mes, e a poda por particao derivada do id erra.
 */
export interface IdGenerator {
  uuidV7(at: Date): string;
  uuid(): string;
}
