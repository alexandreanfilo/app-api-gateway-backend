# app-api-gateway

Plataforma de integrações: recebe ou coleta dados, transforma e entrega em APIs de destino, com os
pipelines definidos em **configuração**, não em código.

**Um artefato, N deployments.** A mesma imagem sobe várias vezes; cada deployment tem seu ambiente,
seu Postgres, seu Redis e seus pipelines. Nada de build por cliente:

| O quê | Como entra |
| --- | --- |
| Definições de pipeline (YAML) | Volume montado, caminho em `PIPELINES_DIR` |
| Certificados (mTLS) | Volume montado, caminho referenciado no YAML |
| Tokens, senhas, `DATABASE_URL` | Variáveis de ambiente |

---

## A ideia central: duas entradas, um motor

Um pipeline recebe dados de duas formas, e **só isso muda**:

- **`http-poll`** — um cron dispara, o app consulta uma API paginada e extrai um array de itens.
  Em vocabulário EIP: *Polling Consumer*.
- **`http-endpoint`** — o app expõe uma rota, um sistema externo faz POST, o corpo vira um ou mais
  itens. Em vocabulário EIP: *Event-Driven Consumer*.

Filtro, split, deduplicação, transformação, entrega, retentativa e auditoria são **idênticos** nos
dois casos. O código garante isso por construção: `PipelineRunner.run()` recebe uma `Source`, não a
união dos dois tipos concretos, e `CompiledPipeline.downstream` não tem discriminante — escrever um
caminho específico por tipo de entrada exigiria alterar um tipo público, o que aparece no diff.

**Os dois são igualmente assíncronos.** Em nenhum caso a entrega ao destino acontece dentro da
entrada. No endpoint, a requisição termina assim que o evento está gravado no Postgres; a
transformação e a entrega correm na fila, exatamente como no poll.

---

## Subir para desenvolvimento

```bash
npm install
docker compose up -d postgres redis
cp .env.example .env            # preencha os segredos referenciados pelos YAML
npm run migrate
npm run start:dev
```

`npm run start`, `start:dev`, `start:prod` e os `migrate` leem o `.env` da raiz sozinhos (via
`--env-file` do Node); não é preciso exportar nada na mão. Só `start` e `start:dev` exigem que o
arquivo exista — os demais seguem sem ele, porque em produção as variáveis vêm do orquestrador.

Ou tudo em container, incluindo o collector de traces:

```bash
docker compose up --build
```

O serviço `gateway` do compose lê o **mesmo** `.env` (`env_file`, opcional), então os segredos
valem para os dois caminhos. Endereço de banco, Redis, OTLP e `PIPELINES_DIR` são sobrescritos no
`environment:` do serviço, porque dentro da rede do compose eles são outros.

Verificando:

```bash
curl localhost:3000/healthz
# {"status":"ok","pipelines":3,"endpoints":[],
#  "polls":["adm-porto-franco-grao-tsm","fto-barcarena-fertilizante-tsm","fto-sao-luis-fertilizante-tsm"]}
```

Hoje só há fluxos de poll: `parceiro-x-eventos.yaml`, o exemplo de entrada por endpoint, está
`enabled: false` até existir parceiro e destino de verdade. Com ele (ou outro `http-endpoint`)
ligado, `endpoints` passa a listar a rota e a entrada é assim:

```bash
curl -X POST localhost:3000/in/parceiro-x-eventos \
  -H 'Content-Type: application/json' -H 'X-Api-Key: <PARCEIRO_X_API_KEY>' \
  -d '{"eventos":[{"id_externo":"E-1","timestamp":"2026-09-17T08:00:00Z"}]}'
# 202 {"accepted":1,...,"items":[{"index":0,"status":"accepted","eventId":"..."}]}

# o mesmo corpo de novo -> 200 com o MESMO eventId
```

### Comandos

| Comando | O que faz |
| --- | --- |
| `npm test` | Unitários + e2e + configuração. **Não precisa de Docker nem de banco.** |
| `npm run test:config` | Só a validação dos pipelines de `pipelines/` contra os mappings legados. |
| `npm run test:integration` | Testes contra Postgres real, via testcontainers. |
| `npm run check` | `tsc --noEmit` + Biome + dependency-cruiser (fronteiras de módulo). |
| `npm run lint` | Biome com `--write`. |
| `npm run migrate` | Aplica as migrations Kysely. |
| `npm run build` | Compila para `dist/`. |

---

## Adicionar um pipeline

Um arquivo `.yaml` por pipeline em `PIPELINES_DIR`. **Não há deploy de código**: basta o arquivo no
volume e reiniciar o processo.

### Entrada por poll

```yaml
id: meu-pipeline                 # kebab-case, único entre todos os arquivos
name: Origem X -> Destino Y
client: nome-do-cliente
enabled: true

source:
  kind: http-poll
  schedule: "*/5 * * * *"
  timezone: America/Sao_Paulo    # opcional; é o fuso em que {today} é resolvido
  method: GET
  url: https://origem.exemplo.com/api/itens
  query:
    de: "{today-2d}"             # resolvido na execução, formato YYYY-MM-DD
    ate: "{today+2d}"
  pagination:
    param: page
    start: 1
    maxPages: 10
  auth:
    kind: login-token
    loginUrl: https://origem.exemplo.com/login
    body:
      username: { secret: ORIGEM_USER }
      password: { secret: ORIGEM_PASS }
    tokenPath: JWT               # caminho do token na resposta do login
    header: X-Authorization
    ttlSeconds: 3000
  itemsPath: dados               # o array a ser quebrado em eventos
  totalCountPath: totalRecords   # opcional: para parar a paginação

filter:
  status: [NP, LF]                          # atalho: campo ∈ lista
  numero_pedido: { numeric: true, notEquals: 0 }  # predicados

dedupe:
  fields: [numero_pedido, status]  # chave COMPOSTA: todos obrigatórios

transform:
  destino_id: { from: numero_pedido, cast: number }
  evento.tipo: { from: status }              # notação de ponto aninha
  origem: { const: MEU_SISTEMA }             # valor fixo
  canal: { from: canal, default: WEB }       # fallback quando falta

destinations:
  - id: destino
    method: POST
    url: https://destino.exemplo.com/eventos
    auth: { kind: bearer, token: { secret: DESTINO_TOKEN } }
    retry: { attempts: 5, backoff: exponential, initialDelayMs: 15000 }
  - id: auditoria                            # Content-Based Router (opcional)
    url: https://auditoria.exemplo.com/eventos
    filter:
      terminal: [PF]                         # só recebe o que casa
```

#### Filtro

`campo: [v1, v2]` é atalho para `campo: { in: [v1, v2] }`. Predicados disponíveis, combinados com
**E** dentro do mesmo campo e entre campos:

| Predicado | Exemplo | Para que serve |
| --- | --- | --- |
| `in` | `status: { in: [NP, TP] }` | pertence ao conjunto |
| `notIn` | `status: { notIn: [CANCELADO] }` | não pertence |
| `equals` / `notEquals` | `numero_pedido: { notEquals: 0 }` | valor único |
| `numeric` | `numero_pedido: { numeric: true }` | é número ou string numérica |
| `exists` | `cancelado_em: { exists: false }` | campo presente / ausente |

Duas regras que valem conhecer:

- **Campo ausente reprova qualquer predicado, exceto `exists: false`.** O filtro existe para
  restringir; um item sem o campo não satisfaz a restrição.
- **Número e string numérica são o mesmo valor** (`41655302` casa com `"41655302"`). Parceiros
  alternam entre os dois para o mesmo ID, e no YAML o operador escreve o número naturalmente — com
  igualdade estrita, o filtro nunca casaria, sem erro e sem log. Booleano e `null` continuam
  estritos: `true` não casa com `"true"` nem com `1`.

O filtro por destino é avaliado no **fan-out**: um destino que não casa simplesmente não gera linha
em `pipeline_delivery`, em vez de gerar uma que nasceria para ser descartada.

### Entrada por endpoint

```yaml
id: parceiro-y
name: Parceiro Y -> destino interno
client: parceiro-y

source:
  kind: http-endpoint
  path: /in/parceiro-y           # o código prefixa com /in/ de qualquer forma
  auth:                          # valida QUEM CHAMA
    kind: static-token
    header: X-Api-Key
    value: { secret: PARCEIRO_Y_API_KEY }
  itemsPath: eventos             # sem ele, o corpo inteiro é um item
  maxBodyBytes: 1048576
  rateLimit: { perMinute: 600 }

dedupe:
  header: Idempotency-Key        # alternativas em cadeia: a primeira que resolver vence
  fields: [id_externo]
  onMissing: reject              # reject | generate (sha256 do item cru)

transform:
  evento_id: { from: id_externo }

destinations:
  - id: interno
    url: https://destino.interno/eventos
    auth: { kind: bearer, token: { secret: DESTINO_INTERNO_BEARER } }
```

#### `enabled: false` torna o arquivo inerte

Desabilitar um pipeline é a forma de **parar** um fluxo — inclusive quando o contrato do cliente
terminou e o token já saiu do ambiente. Por isso um arquivo desabilitado não tem seus segredos
exigidos no boot e não disputa rota com ninguém. O schema, esse sim, continua sendo validado: o YAML
tem que ser bem formado, porque isso é propriedade do artefato, não do ambiente.

#### Avisos de boot

Dois pipelines de poll que consultam a **mesma origem** e entregam no **mesmo destino** geram um
aviso (não um erro — mesma origem com filtros e destinos diferentes é legítimo). Sem ele, o sintoma
seria cobrança em duplicidade do outro lado, semanas depois.

Depois, exporte as variáveis de ambiente com os nomes usados em `{ secret: NOME }` e reinicie.
**YAML inválido impede o app de subir**, com o arquivo e o campo na mensagem:

```
Configuracao invalida (1 erro(s) em 1 arquivo(s)):

  meu-pipeline.yaml: source.auth.body.password: esperado { secret: REF } -- segredo em texto puro nao e permitido

Nenhum pipeline foi iniciado.
```

### Regras do schema que valem conhecer

- **Nunca valor literal em campo de credencial.** Só `{ secret: REF }`. O schema rejeita string crua,
  inclusive dentro do corpo do `login-token` (por heurística de nome de chave).
- **`source.kind` é união discriminada estrita**: um campo de poll dentro de um `http-endpoint`
  (ou vice-versa) é recusado no boot.
- **Dois pipelines com o mesmo `path` derrubam o boot**, mesmo escritos de formas diferentes
  (`eventos` e `/in/eventos` são a mesma rota).
- O `path` não pode colidir com `/healthz`, `/readyz`, `/metrics` ou `/admin`.
- `cast` disponível: `string`, `number`, `integer`, `boolean`, `iso-date`, `epoch-millis`, `trim`,
  `upper`, `lower`. Um cast impossível **rejeita o item** em vez de enviar `NaN` ao destino.
- Campo ausente e sem `default` é **omitido** do payload — não vira `null`.

---

## Subir um deployment novo

1. **Banco e Redis próprios.** Não compartilhe entre deployments: as instâncias consomem a mesma
   fila de entrega, e um deployment processaria eventos do outro.
2. Monte o volume de pipelines e o de certificados.
3. Defina as variáveis de ambiente (veja `.env.example`); toda referência `{ secret: NOME }` dos YAML
   precisa existir, senão o boot falha dizendo qual falta.
4. Rode as migrations **uma vez** por deploy (não em todo pod): `node dist/scripts/migrate.js up`.
   No compose isso é o serviço `migrate`.
5. Suba a aplicação.

### Restrições de infraestrutura que não são detalhe

- **Conexão direta ao Postgres, ou pooler em modo `session`.** O lock de coleta usa
  `pg_try_advisory_lock` de sessão, que **não funciona com PgBouncer em modo `transaction`** — cada
  statement pode ir por outra conexão do servidor, e o lock deixa de valer. Descobrir isso em
  produção custa uma coleta duplicada silenciosa.
- **Redis em `maxmemory-policy noeviction`.** Com qualquer política de despejo, o BullMQ descarta
  jobs em silêncio quando o Redis enche.
- Escalar horizontalmente é seguro: o cron de coleta é protegido por advisory lock por pipeline, e
  a entrega é protegida por claim atômico com lease.

---

## Operação

### Onde está a verdade

**No Postgres, não no Redis.** A fila é aceleração; a garantia é a linha no banco. Perder o Redis
custa **atraso**, não evento: um drenador por cron reconstrói a fila a partir das entregas
`PENDING`/`FAILED`. É por isso que o `202` do endpoint pode ser respondido antes de o
enfileiramento dar certo.

### As três tabelas

- **`pipeline_run`** — uma linha por unidade de entrada: no poll, uma por *página* consultada; no
  endpoint, uma por *requisição* (com IP de origem e tamanho do corpo). Particionada por mês.
- **`pipeline_event`** — um evento único por `(pipeline_id, dedupe_key)`, com o item cru da origem.
  **Não é particionada**, e isso é deliberado: a unicidade precisa ser global.
- **`pipeline_delivery`** — uma por (evento × destino), com status independente. É a maior tabela do
  sistema. Particionada por mês.

`pipeline_id` vem do YAML e **não é FK para lugar nenhum**: a definição do pipeline é artefato de
deploy, não dado de aplicação.

### Máquina de estados da entrega

```
PENDING ──claim──► IN_FLIGHT ──2xx────────────────► DELIVERED   (terminal)
   ▲                   │
   │                   ├──4xx (exceto 408/429), 3xx─► DISCARDED (NON_RETRYABLE_STATUS)
   │                   ├──5xx/408/429/rede ─┬─ tem tentativa ─► FAILED ──claim──► IN_FLIGHT
   │                   │                    └─ esgotou ───────► DISCARDED (ATTEMPTS_EXHAUSTED)
   │                   └──lease expirado (reaper) ──────────► FAILED ou DISCARDED
   └──────────── replay manual (única aresta para trás, com enqueue_seq++) ────────┘
```

O Postgres é o **teto** (`max_attempts`/`attempt_count`, duráveis); o BullMQ é o **relógio** (quando
a próxima tentativa roda). Os dois nunca divergem porque compartilham a mesma função
`computeBackoff()`.

### Consultas de plantão

```sql
-- "cadê a nota 12345?" — responde sem JOIN, usando o índice por dedupe_key
SELECT d.status, d.attempt_count, d.response_status, d.error_code, d.discard_reason
  FROM pipeline_delivery d
 WHERE d.pipeline_id = 'meu-pipeline'
   AND d.dedupe_key = encode(sha256('field:id=12345'::bytea), 'hex');

-- o que está travado agora
SELECT pipeline_id, destination_id, status, count(*)
  FROM pipeline_delivery
 WHERE status IN ('PENDING','FAILED','IN_FLIGHT')
 GROUP BY 1,2,3;

-- ALERTA: a partição DEFAULT deve estar SEMPRE vazia. Com linhas, criar a
-- próxima partição vira ACCESS EXCLUSIVE de minutos na maior tabela do sistema.
SELECT count(*) FROM pipeline_delivery_default;
```

### Métricas que pagam plantão

`gateway.source.staleness` (a fonte parou de responder), `gateway.deliveries{outcome="dead"}`
(evento perdido de verdade), `gateway.delivery.duplicate_detected` (o fencing do lease flagrou uma
entrega dupla), `gateway.drain.resurrected` (a fila perdeu jobs) e
`gateway.partition.default_rows` (deve ser sempre zero).

### Retenção

`pipeline_run` (2 meses) e `pipeline_delivery` (6 meses) são podadas por **DROP de partição**, que é
O(1); `pipeline_event` é purgada por DELETE em lote com janela ≥ `dedupe.ttlDays`. A política vive na
tabela `gw_partition_policy`, não em variável de ambiente: um deployment pode precisar de 24 meses
por exigência de auditoria e outro de 2, sem redeployar o artefato.

> Apagar um evento faz o item **voltar a parecer novo**. Se o poll consulta uma API que devolve os
> últimos 30 dias e a purga corta em 15, tudo é reentregue. Por isso a purga recusa rodar com janela
> menor que a configurada.

---

## Observabilidade

`OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) aponta para o collector. Spans de
domínio: `gateway.collect`, `gateway.page`, `gateway.ingest`, `gateway.dedupe`, `gateway.deliver` —
e o contexto de trace **atravessa o BullMQ**, então um trace liga a requisição recebida à entrega
feita minutos depois.

`OTEL_SDK_DISABLED=true` desliga tudo (é o que os testes usam).

---

## Segurança

- **Nenhuma credencial em claro** — não em coluna, não em YAML, não em código, não neste README.
  Só `{ secret: REF }`.
- Segredos resolvidos são embrulhados em `Secret`, que não vaza por `JSON.stringify`, por
  `console.log` nem por template string.
- O log e a auditoria só aceitam valores do tipo `Masked<T>`: passar headers crus **não compila**.
  Além do mascaramento por nome de chave, há *scrubbing por valor* — todo segredo resolvido é
  removido de qualquer string emitida, inclusive de mensagens de erro do parceiro.
- Comparação de token de entrada em **tempo constante**.
- **Sem SQL nem código vindo de configuração.** O motor não executa nada definido em YAML.

---

## Fora de escopo nesta versão

UI de acompanhamento, OAuth2, mTLS, HMAC e SOAP. Os pontos de extensão estão marcados:
`InboundAuthSchema` e `OutboundAuthSchema` são uniões discriminadas às quais se acrescenta um membro;
o `SecretResolver` troca por uma classe nova (AWS Secrets Manager) sem tocar em nenhum YAML.

**O sistema é assíncrono por decisão, não por escopo.** Não existe modo síncrono e não deve ser
criado ponto de extensão para isso; pelo mesmo motivo não existe callback devolvendo a resposta do
destino ao originador.
