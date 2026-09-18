import type { IdGenerator } from '../../src/core/ports/id-generator';
import { uuidV7 } from '../../src/persistence/uuid';

/** Sequencial e deterministico: os testes podem afirmar ids exatos. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  uuidV7(at: Date): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `${uuidV7(at).slice(0, 24)}${suffix}`;
  }

  uuid(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}
