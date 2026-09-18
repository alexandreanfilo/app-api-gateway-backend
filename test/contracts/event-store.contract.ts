import type { EventStore, NewEventInput } from '../../src/core/ports/event-store';
import { asDedupeKey, asPipelineId, asRunId } from '../../src/core/types/ids';

export interface ContractSubject {
  store: EventStore;
  /** Um segundo EventStore sobre a MESMA base, para exercitar concorrencia. */
  concurrent?: EventStore;
  cleanup(): Promise<void>;
}

const PIPELINE = asPipelineId('contrato');

function input(key: string, overrides: Partial<NewEventInput> = {}): NewEventInput {
  const runCreatedAt = overrides.runCreatedAt ?? new Date('2026-09-17T12:00:00.000Z');
  return {
    pipelineId: PIPELINE,
    dedupeKey: asDedupeKey(key),
    dedupeSource: `field:id=${key}`,
    runId: asRunId('00000000-0000-7000-8000-000000000001'),
    runCreatedAt,
    payload: { id: key, valor: 1 },
    ...overrides,
  };
}

/**
 * UMA suite, DOIS sujeitos: o fake em memoria (projeto `unit`) e o repositorio
 * Kysely contra Postgres real (projeto `int`).
 *
 * E isto que resolve a tensao "a deduplicacao exige Postgres de verdade" versus
 * "npm test precisa passar sem infra": o `npm test` valida que o fake e
 * realista -- e portanto que os testes de motor que o usam testam alguma coisa
 * --, e o CI valida que o Postgres honra o mesmo contrato. Quando os dois
 * divergirem, o contrato quebra, em vez de a diferenca aparecer em producao.
 */
export function eventStoreContract(
  name: string,
  makeSubject: () => Promise<ContractSubject>,
): void {
  describe(`contrato do EventStore: ${name}`, () => {
    let subject: ContractSubject;

    beforeEach(async () => {
      subject = await makeSubject();
    });

    afterEach(async () => {
      await subject.cleanup();
    });

    it('a primeira insercao devolve todas as chaves como novas', async () => {
      const result = await subject.store.insertNewOnly([input('a'), input('b')]);

      expect(result.inserted).toHaveLength(2);
      expect(result.duplicateKeys).toHaveLength(0);
      expect(result.receivedCount).toBe(2);
    });

    it('a segunda passagem com as mesmas chaves nao insere nada', async () => {
      await subject.store.insertNewOnly([input('a'), input('b')]);
      const segunda = await subject.store.insertNewOnly([input('a'), input('b')]);

      expect(segunda.inserted).toHaveLength(0);
      expect(segunda.duplicateKeys.map(String).sort()).toEqual(['a', 'b']);
    });

    it('num lote misto, devolve apenas as chaves realmente novas', async () => {
      await subject.store.insertNewOnly([input('a')]);
      const misto = await subject.store.insertNewOnly([input('a'), input('b'), input('c')]);

      expect(misto.inserted.map((e) => String(e.dedupeKey)).sort()).toEqual(['b', 'c']);
      expect(misto.duplicateKeys.map(String)).toEqual(['a']);
    });

    it('colapsa duplicatas dentro do proprio lote e as reporta', async () => {
      const result = await subject.store.insertNewOnly([input('a'), input('a'), input('a')]);

      expect(result.inserted).toHaveLength(1);
      expect(result.intraBatchDupes).toBe(2);
      expect(result.receivedCount).toBe(3);
    });

    it('a mesma chave em pipelines diferentes sao eventos diferentes', async () => {
      await subject.store.insertNewOnly([input('a')]);
      const outro = await subject.store.insertNewOnly([
        input('a', { pipelineId: asPipelineId('outro-pipeline') }),
      ]);

      // A unicidade e (pipeline_id, dedupe_key): um pipeline nao pode "roubar"
      // a chave de outro so porque o parceiro usou o mesmo identificador.
      expect(outro.inserted).toHaveLength(1);
    });

    it('devolve o evento original quando consultado pela chave', async () => {
      const primeira = await subject.store.insertNewOnly([input('a')]);
      const original = primeira.inserted[0];

      const encontrado = await subject.store.findByDedupeKey(PIPELINE, asDedupeKey('a'));
      const emLote = await subject.store.findManyByDedupeKey(PIPELINE, [asDedupeKey('a')]);

      // E disto que sai o 200 com o id do evento ORIGINAL no reenvio.
      expect(encontrado?.id).toBe(original?.id);
      expect(emLote.map((e) => e.id)).toEqual([original?.id]);
    });

    it('guarda o item cru da origem', async () => {
      const result = await subject.store.insertNewOnly([input('a')]);
      const eventId = result.inserted[0]?.id;
      expect(eventId).toBeDefined();
      if (eventId === undefined) return;

      expect(await subject.store.payloadOf(eventId)).toEqual({ id: 'a', valor: 1 });
    });

    it('o evento nasce com o created_at da execucao, nao com o do relogio', async () => {
      const runCreatedAt = new Date('2026-01-15T03:04:05.000Z');
      const result = await subject.store.insertNewOnly([input('a', { runCreatedAt })]);

      // As entregas herdam este created_at, e e ele que mantem evento e entregas
      // na mesma particao mensal.
      expect(result.inserted[0]?.createdAt.toISOString()).toBe(runCreatedAt.toISOString());
    });

    /**
     * SELECT-entao-INSERT passa em teste sequencial e falha em producao. So um
     * Postgres real prova este caso: dois claims simultaneos da mesma chave
     * precisam ter exatamente um vencedor.
     */
    it('sob concorrencia, exatamente um dos dois insere a chave', async () => {
      if (subject.concurrent === undefined) {
        // O fake e monothread; a corrida nao existe nele. O caso continua
        // declarado aqui para que o sujeito real o execute.
        return;
      }

      const [a, b] = await Promise.all([
        subject.store.insertNewOnly([input('corrida')]),
        subject.concurrent.insertNewOnly([input('corrida')]),
      ]);

      expect(a.inserted.length + b.inserted.length).toBe(1);
      expect(a.duplicateKeys.length + b.duplicateKeys.length).toBe(1);
    });
  });
}
