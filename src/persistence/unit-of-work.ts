import { Inject, Injectable } from '@nestjs/common';
import type { UnitOfWork } from '../core/ports/unit-of-work';
import { DATABASE, type Db } from './database';

@Injectable()
export class KyselyUnitOfWork implements UnitOfWork {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * Transacao CURTA: so banco. Nenhuma chamada HTTP aqui dentro, nunca --
   * segurar transacao aberta durante I/O de rede trava o xmin e o autovacuum
   * para de limpar o banco INTEIRO.
   */
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => fn(trx));
  }
}
