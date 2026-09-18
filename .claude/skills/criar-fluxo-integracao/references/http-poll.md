# Entrada por `http-poll`

O cron dispara, o gateway consulta uma API paginada e extrai um array de itens. Em vocabulário EIP:
*Polling Consumer*.

O gateway escala horizontalmente e o cron dispara em **toda** instância, então a coleta é protegida
por um lock por pipeline — você não precisa fazer nada a respeito, mas é a razão de não haver estado
de paginação no YAML.

## Bloco `source` completo

```yaml
source:
  kind: http-poll

  # Expressão cron de 5 campos. */5 * * * * = a cada cinco minutos.
  schedule: "*/5 * * * *"

  # Fuso em que os placeholders de data são resolvidos. Default America/Sao_Paulo.
  # Importa de verdade: entre 21h e meia-noite em Brasília, "hoje" em UTC já é o
  # dia seguinte, e a janela sairia errada só nesse intervalo do dia.
  timezone: America/Sao_Paulo

  method: GET                      # GET ou POST
  url: https://origem.exemplo.com/api/list/recurso/

  # Query string. Placeholders de data resolvidos na execução, formato YYYY-MM-DD.
  query:
    data_inicial_agendamento: "{today}"
    # data_final_agendamento: "{today+2d}"   # {today}, {today-Nd}, {today+Nd}

  headers:                         # opcional, headers fixos
    Accept: application/json

  auth:
    kind: api-key
    header: X-Authorization
    value: { secret: ORIGEM_TOKEN }

  # Opcional. Sem o bloco, faz uma requisição só.
  pagination:
    param: page                    # nome do parâmetro de página
    start: 1                       # primeira página
    maxPages: 50                   # teto duro por execução

  itemsPath: recurso               # o array a ser quebrado em eventos
  totalCountPath: totalRecordCount # opcional, ajuda a parar a paginação
  timeoutMs: 30000                 # opcional
```

## Paginação: como ela realmente para

Três condições, e todas existem por um motivo:

1. **Página vazia** — cobre a API que não declara total.
2. **`totalCountPath` alcançado** — evita a requisição inútil que só confirma o fim. O gateway conta
   os itens recebidos; ele **não** precisa saber o tamanho da página, então mudar a paginação do
   parceiro não quebra nada.
3. **`maxPages`** — teto duro contra uma API que sempre devolve a mesma página. Sem ele, um bug do
   parceiro vira laço infinito.

Toda a paginação acontece **dentro de uma execução**. Não há cursor guardado entre execuções, e é
deliberado: cursor persistido é estado mutável compartilhado, que trava numa página vazia e faz a
integração parar em silêncio.

Dimensione `maxPages` pelo volume real: `maxPages × itens_por_página` é o teto de itens por ciclo.
Se a origem tiver mais que isso numa janela, o excedente não é coletado — cada ciclo recomeça na
página 1.

## `auth` de saída — qual usar

```yaml
# Token fixo num header qualquer. É o caso mais comum com as APIs de agendamento.
auth:
  kind: api-key
  header: X-Authorization
  value: { secret: ORIGEM_TOKEN }

# Authorization: Bearer <token>
auth:
  kind: bearer
  token: { secret: ORIGEM_TOKEN }

# Authorization: Basic base64(usuario:senha)
auth:
  kind: basic
  username: usuario
  password: { secret: ORIGEM_SENHA }

# Faz login antes, extrai o token da resposta e o cacheia (compartilhado entre
# instâncias, então é um login por TTL e não um por réplica).
auth:
  kind: login-token
  loginUrl: https://origem.exemplo.com/api/login
  method: POST
  body:
    username: { secret: ORIGEM_USER }
    password: { secret: ORIGEM_SENHA }
  tokenPath: JWT          # caminho do token na resposta do login
  header: X-Authorization # onde mandar o token nas chamadas seguintes
  ttlSeconds: 3000

auth: { kind: none }
```

Como decidir entre `api-key` e `login-token`: se o `curl` homologado já traz o token pronto no
header, é `api-key`. Se existe um endpoint de login que devolve um token com validade, é
`login-token`. Na dúvida, **pergunte** — os dois falham com 401, mas `api-key` com um JWT expirado
falha só depois de um tempo, o que é bem mais difícil de diagnosticar.

## `dedupe` no poll

Chave **composta**: todos os campos são obrigatórios, e um item sem qualquer um deles é rejeitado.

```yaml
dedupe:
  fields: [numero_pedido, status]
  ttlDays: 90        # opcional
```

`header` e `onMissing` não valem aqui — são do endpoint, e o schema recusa.

## Modelo completo, no padrão GTS → TSM

Os três fluxos em produção seguem exatamente esta forma; diferem em `id`, `name`, `client`, `url` e
os dois segredos.

```yaml
# <Cliente> <Local> (<produto>) -> TSM Integrator.
id: cliente-local-produto-tsm
name: Cliente Local (produto) -> TSM Integrator
client: cliente
enabled: true

source:
  kind: http-poll
  schedule: "*/5 * * * *"
  timezone: America/Sao_Paulo
  method: GET
  url: https://origem.lyin-s.com/api/list/agendamento_produto/
  query:
    data_inicial_agendamento: "{today}"
  pagination:
    param: page
    start: 1
    maxPages: 50
  auth:
    kind: api-key
    header: X-Authorization
    value: { secret: CLIENTE_LOCAL_TOKEN }
  itemsPath: agendamento_produto
  totalCountPath: totalRecordCount

filter:
  status: [NP, LF, TP, CH]
  numero_pedido: { numeric: true, notEquals: 0 }

dedupe:
  fields: [numero_pedido, status]

transform:
  agendamento_id: { from: numero_pedido, cast: number }
  data: { from: data_status }
  evento.id: { from: status }

destinations:
  - id: tsm
    method: POST
    url: https://api.trizy.com.br/tsm-integrator/events
    auth:
      kind: bearer
      token: { secret: CLIENTE_LOCAL_TSM_TOKEN }
    retry:
      attempts: 5
      backoff: exponential
      initialDelayMs: 15000
```

Note que a lista de status **varia por fluxo** (grão usa `[NP, TP]`; fertilizante usa
`[NP, LF, TP, CH]`). Não copie sem confirmar: um status a menos descarta eventos legítimos sem erro
nenhum.
