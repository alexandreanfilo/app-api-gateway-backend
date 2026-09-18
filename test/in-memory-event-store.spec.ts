import { eventStoreContract } from './contracts/event-store.contract';
import { InMemoryEventStore } from './fakes/in-memory-stores';

// O fake roda o MESMO contrato que o repositorio Kysely. Se ele passar a mentir
// sobre a semantica de deduplicacao, os testes de motor que o usam deixariam de
// provar qualquer coisa -- e este arquivo e o que impede isso em silencio.
eventStoreContract('em memoria', async () => ({
  store: new InMemoryEventStore(),
  cleanup: async () => undefined,
}));
