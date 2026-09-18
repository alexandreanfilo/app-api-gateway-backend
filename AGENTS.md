# Convenções do app-api-gateway

Regras deste repositório. As que têm "**por quê**" vieram de um problema observado — não são gosto.

---

## 1. A fronteira de `core/` é real

`core/` é o motor. Ele **não pode** importar de `config/`, `persistence/`, `http/`, `queue/` nem
`observability/`, e **não pode** importar framework nenhum: nem `@nestjs/*`, nem `kysely`, nem
`bullmq`, nem `zod`, nem `consola`. Só builtins do Node e `@opentelemetry/api`.

Três ferramentas garantem isso, com papéis diferentes:

| Ferramenta | Quando roda | Papel |
| --- | --- | --- |
| Biome `noRestrictedImports` | no editor | feedback em segundos; casa o especificador, não o caminho resolvido — é conveniência, **não garantia** |
| `test/architecture.spec.ts` | `npm test` | onde a violação é mais barata de descobrir |
| dependency-cruiser | CI / pre-push | **o portão** |

`tsPreCompilationDeps: true` no `.dependency-cruiser.cjs` não é opcional: sem ele
`import type { Db } from '../persistence/db'` some do grafo (é apagado na compilação) e a fronteira
vaza justamente por tipos, que é como o acoplamento sempre começa.

**Como `core/` fala com o mundo:** portas em `core/ports/*.ts` (só tipos + um `Symbol`),
implementadas em `persistence/`/`http/`/`queue/`, ligadas em `app.module.ts` — o único arquivo que
conhece os dois lados. `core/` não tem decorators, nem `@Injectable()`: isso importaria
`@nestjs/common` para dentro dele.

---

## 2. Nenhum nome de cliente no código

Nenhum arquivo em `src/` menciona cliente, terminal ou órgão. Pipelines são **dados**: um YAML no
volume. Um `if` com nome de cliente dentro do motor significa que o desenho errou, e o teste de
arquitetura falha o build.

---

## 3. Credenciais

- **Só `{ secret: REF }`** em campo de credencial. Em nenhum lugar existe
  `z.union([z.string(), secretRef()])` — é exatamente essa união que permitiria o vazamento.
- O YAML carrega **nome lógico**, nunca caminho de provedor. Se alguém propuser
  `{ secret: 'arn:aws:secretsmanager:...' }`, recuse: acopla a configuração ao backend e quebra a
  promessa de trocar por AWS Secrets Manager com uma classe nova.
- Credencial resolvida é um `Secret`. O valor só sai por `.expose()`, e `.expose()` só é chamado em
  **um** lugar: `materializeHeaders()`, a última linha antes do envio.
- **Nunca interpole um `Secret` em template string.** `` `Bearer ${secret}` `` produz
  `Bearer [secret:X]` em silêncio, e o header sai errado sem erro nenhum.
- `consola` só pode ser importado por `src/observability/logger.ts`. Sem essa regra, o primeiro
  `consola.error(err)` num catch qualquer derrota todo o mascaramento: o erro do undici carrega os
  headers da requisição, `Authorization` incluso.
- Log e auditoria só aceitam `Masked<T>`. Passar headers crus **não compila** — foi assim que
  "lembre-se de mascarar" virou erro de tipo.

---

## 4. Armadilhas que já custaram caro aqui

### `import type` em classe injetada pelo Nest

O autofix do Biome (`useImportType`) converte sozinho, a classe é apagada em runtime,
`design:paramtypes` vira `undefined` e o app **não sobe** — com erro de boot, não de compilação.

Por isso a regra está **desligada** no `biome.json` e verificada em `test/architecture.spec.ts`.
Parâmetro com `@Inject(TOKEN)` é imune (não usa `design:paramtypes`); parâmetro sem token, não.

### Parâmetro de construtor com valor padrão

`constructor(private readonly opts: X = { ... })` **não funciona** com o container: ele lê
`design:paramtypes`, vê `Object` e tenta resolver um provider que não existe. Use um token
(`PERSISTENCE_OPTIONS` é o exemplo) e deixe o default só para quem instancia com `new`.

### CommonJS é requisito, não preferência

`tsconfig.json` fixa `"module": "commonjs"`. Em ESM, todos os `import` são içados e
`@nestjs/core`, `express`, `pg` e `ioredis` já estão carregados quando `instrumentation.ts` roda: as
auto-instrumentations do OpenTelemetry **silenciosamente não instrumentam nada**. Sem erro, sem
aviso — só spans faltando, descobertos meses depois.

Isso também fixa **NestJS 11**: a linha 12 é ESM-only. Ver o cabeçalho de `src/instrumentation.ts`.

### Express 5 (path-to-regexp 8)

`@All('*')` **lança no boot**. O curinga é `*path` — e `req.params.path` vem como **array de
segmentos**, não string. Use `req.path`.

---

## 4b. `enabled: false` é inerte

Um pipeline desabilitado **não** tem segredos exigidos no boot e **não** participa das checagens
cross-file. Sem isso, o campo inverte de sentido: parar o fluxo de um cliente cujo token foi revogado
passaria a derrubar o gateway de todos os outros. O schema continua sendo validado para todos os
arquivos — o artefato tem que ser bem formado; só o ambiente é que é opcional.

---

## 5. O motor

- Steps (`core/steps/*`) são **funções puras**: sem I/O, sem `Date.now()`, sem `crypto` global. Quem
  precisa de tempo recebe a porta `Clock`.
- Rejeição é **dado**, não exceção: os steps devolvem `Result<T, E>`. Um `throw` no meio de um lote
  de 500 itens jogaria 499 itens bons fora.
- O `filter` compara número e string numérica como iguais (`41655302` ≡ `"41655302"`), e **só**
  isso: booleano e `null` são estritos. Não é frouxidão por comodidade — é que o YAML não sabe o
  tipo que a origem devolve, e igualdade estrita transformaria um filtro errado em falha silenciosa.
- O discriminante de `source.kind` **morre em `config/compile-pipeline.ts`**. Se você precisar de um
  `if (source.kind === ...)` a jusante, o lugar de resolver é o compilador, não o step.
- A entrada **nunca** chama um destino. O `PipelineRunner` nem recebe um `HttpClient`: a ausência da
  porta é o que torna a entrega inline impossível, em vez de apenas desencorajada.

---

## 6. Fila e entrega

- **`removeOnFail` nunca `true`.** Também não é `false` literal: é
  `{ age: 7d, count: 100_000 }`. `false` é ilimitado, e o BullMQ exige Redis em
  `noeviction` — "guardar para sempre" termina com o Redis cheio e a fila parada. A evidência
  canônica da falha está no Postgres.
- **`jobId` é `d:<delivery_id>:<enqueue_seq>`.** O `seq` existe porque um job que esgota tentativas
  fica no set `failed` **com aquele id, para sempre**, e `add()` com id existente é no-op
  **silencioso**. Sem incrementar o seq, uma entrega ressuscitada nunca roda enquanto o log afirma
  que foi reenfileirada.
- **Nunca ponha payload em `job.data`.** Ele vai para o Redis em JSON legível. O job carrega
  ponteiro; o corpo é renderizado na hora do envio — o que, de quebra, faz corrigir o `transform` no
  YAML consertar as retentativas pendentes sem replay.
- **4xx não é retentado** (exceto 408 e 429) e o worker **retorna sem lançar**: o banco já declarou
  terminal, e lançar faria o BullMQ retentar o que jamais será retentado.
- Um 2xx **fora** de `successStatuses` também não retenta: o destino já processou, e reenviar
  duplica do lado dele.
- **`attempt_count` incrementa no claim, antes do HTTP.** Um payload que derruba o processo consome
  tentativas e acaba `DISCARDED`, em vez de derrubar a frota em laço infinito.
- **Isolamento entre destinos é estrutural**, não `try/catch`: existe um job por (evento × destino).
  Um `for...of` com try/catch ainda compartilharia contador de tentativas, backoff e slot de worker.
- **Pipeline desconhecido ≠ destino removido.** Uma réplica sem o YAML (deploy rolante) **não pode**
  descartar a entrega — seria destruir o evento de outra réplica por ignorância local. Descarte só
  quando o pipeline é conhecido e o destino sumiu dele.

---

## 7. Banco

- **`created_at` da entrega é o do evento**, nunca `now()`. É o que mantém evento e entregas na mesma
  partição e faz a busca por `dedupe_key` podar identicamente nas duas tabelas.
- **`created_at` é imutável no tipo** (`ColumnType<Date, Date, never>`): o TypeScript recusa UPDATE
  na chave de partição. O Postgres permitiria, movendo a linha de partição.
- Toda leitura/escrita de linha particionada carrega `created_at` no `WHERE`. Sem isso, cada acesso
  vira busca em N partições.
- **Dedupe é `INSERT ... ON CONFLICT DO NOTHING RETURNING`**, uma declaração. `SELECT`-então-`INSERT`
  tem corrida real entre workers e passa em teste sequencial.
- Antes do insert em lote: deduplicar **em memória** e **ordenar por `dedupe_key`**. Dois pods com o
  mesmo webhook retransmitido, em ordens diferentes, entram em deadlock no índice único.
- **`pipeline_event` não é particionada.** Particionar por mês forçaria `created_at` dentro da
  UNIQUE, e o mesmo item entraria de novo no mês seguinte. Se o volume exigir, é HASH pela tupla de
  dedupe, não RANGE por data.
- O índice parcial do drenador inclui **`IN_FLIGHT`**: sem ele, uma entrega órfã de instância morta
  fica invisível a qualquer consulta indexada.
- Nunca segure uma transação aberta durante chamada HTTP (`idle in transaction` trava o autovacuum
  do banco inteiro). O lock de coleta é advisory de **sessão**, em conexão **fixada** via
  `db.connection()`.

---

## 8. Testes

Quatro projetos Jest:

- **`unit`** — `src/**/*.spec.ts` e `test/**/*.spec.ts`. Sem infra. Testa o **motor**, sempre sobre
  fixtures sintéticas de `test/fixtures/pipelines/`.
- **`e2e`** — `test/**/*.e2e-spec.ts`. App Nest real + supertest, com adaptadores em memória.
- **`config`** — `test/**/*.config-spec.ts`. Valida a **configuração de produção** (`pipelines/`).
- **`int`** — `test/**/*.int-spec.ts`. Postgres real via testcontainers.

`npm test` roda `unit` + `e2e` + `config` e **não pode** exigir Docker.

**Teste de motor não olha para pipeline real.** As fixtures em `test/fixtures/pipelines/` são
sintéticas de propósito — nenhum cliente, origem ou destino de verdade. Um YAML de produção muda por
motivo de negócio (um status novo, outra janela de datas) e derrubaria dezenas de testes que nada
têm a ver com aquela mudança; pior, o sinal ficaria ilegível, porque não dá para saber se quebrou o
motor ou só a configuração.

O único lugar que lê `pipelines/` é o projeto `config`, e lá isso é o ponto: ele existe justamente
para quebrar quando um fluxo real muda sem querer.

**Contract tests.** Um `EventStore` precisa passar na mesma suíte
(`test/contracts/event-store.contract.ts`) como fake em memória e como repositório Kysely. Isso é o
que garante que os testes de motor que usam o fake estejam testando algo realista — quando os dois
divergirem, o contrato quebra em vez de a diferença aparecer em produção.

Outras regras:

- Mensagem de erro de configuração tem teste de **string exata**. Ela é interface de usuário; se não
  estiver sob teste, apodrece.
- HTTP de saída se testa com `undici.MockAgent`, **não** `nock`: o Node 24 usa `fetch` global sobre
  undici, e o nock intercepta `http.ClientRequest`.
- `configureHttp()` é compartilhado entre `main.ts` e os e2e. Se o `express.raw` nascer dentro do
  `bootstrap()`, o teste exercita um caminho diferente do de produção e passa por engano.
- `@swc/jest` **não faz typecheck**. `npm run check` é o que verifica tipos.

---

## 9. Estilo

- Biome decide formatação. Rode `npm run lint` antes de commitar.
- Comentário explica **por que**, não o que. Se a linha é óbvia, não comente; se a decisão é
  contraintuitiva, o comentário é obrigatório e deve dizer o que quebra sem ela.
- Mensagens de log e de erro em português, como o resto da base.
- Nada de `any`. `unknown` + narrowing.
- Nada de NUL literal (ou qualquer caractere invisível) em arquivo-fonte: construa com
  `String.fromCharCode(0)`.

---

## 10. Antes de abrir PR

```bash
npm run check   # tsc + biome + dependency-cruiser
npm test        # unit + e2e
npm run test:integration   # se mexeu em persistence/ ou em migration
```
