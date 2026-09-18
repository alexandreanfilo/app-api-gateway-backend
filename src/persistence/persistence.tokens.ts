/**
 * Opcoes de persistencia injetadas por token.
 *
 * Um parametro de construtor com valor padrao (`opts: X = {...}`) NAO funciona
 * com o container do Nest: ele le design:paramtypes, ve `Object`, e tenta
 * resolver um provider inexistente. O default so vale para quem instancia a
 * classe com `new` -- nos testes, por exemplo.
 */
export const PERSISTENCE_OPTIONS = Symbol('PersistenceOptions');

export interface PersistenceOptions {
  readonly partitionMonthsAhead: number;
  readonly onPartitionRecovered?: (table: string) => void;
}

export const DEFAULT_PERSISTENCE_OPTIONS: PersistenceOptions = { partitionMonthsAhead: 3 };
