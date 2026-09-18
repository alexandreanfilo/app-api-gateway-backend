# Entrada por `http-endpoint`

O gateway expõe uma rota, um sistema externo faz POST, e o corpo vira um ou mais itens. Em
vocabulário EIP: *Event-Driven Consumer*.

O que muda em relação ao poll é só a entrada. Filtro, split, deduplicação, transformação e entrega
são os mesmos — e, como no poll, **a entrega nunca acontece dentro da requisição**: o evento é
gravado, a resposta sai, e a entrega corre na fila. Quem chama recebe "recebi e vou entregar", nunca
a resposta do destino.

## Bloco `source` completo

```yaml
source:
  kind: http-endpoint

  # Sufixo da rota. O código prefixa tudo com /in/ de qualquer forma, então
  # `parceiro-y` e `/in/parceiro-y` dão na mesma. Esse prefixo é o que impede um
  # pipeline de registrar rota que colida com /healthz, /readyz ou /metrics.
  path: /in/parceiro-y

  methods: [POST]           # POST, PUT, PATCH. Default [POST].

  # Valida QUEM CHAMA. Conjunto de tipos distinto do auth de saída.
  auth:
    kind: static-token
    header: X-Api-Key       # default Authorization
    value: { secret: PARCEIRO_Y_API_KEY }
    # scheme: raw           # `bearer` tira o prefixo "Bearer " antes de comparar.
                            # Default: bearer se o header é Authorization, senão raw.

  itemsPath: eventos        # sem ele, o corpo inteiro é UM item
  maxBodyBytes: 1048576     # default 1 MiB
  rateLimit:
    perMinute: 600          # opcional
```

`hmac` e `mtls` ainda não existem como `kind` de entrada — são pontos de extensão. Se o parceiro
exigir um deles, isso é código no motor, não configuração: relate em vez de improvisar.

## `dedupe` no endpoint — alternativas em cadeia

Aqui a chave pode vir do header **ou** do payload, e a primeira que resolver vence:

```yaml
dedupe:
  header: Idempotency-Key   # 1ª alternativa
  fields: [id_externo]      # 2ª alternativa, se o header faltar
  onMissing: reject         # obrigatório: reject | generate
  ttlDays: 90
```

`onMissing` é obrigatório porque as duas escolhas têm consequências opostas e nenhuma é segura como
default silencioso:

- **`reject`** — item sem chave é recusado, com o motivo na resposta. Escolha isto quando o parceiro
  controla o identificador e um evento sem id é sinal de erro dele.
- **`generate`** — a chave vira o sha256 do item cru. O reenvio do payload idêntico ainda deduplica,
  que é o objetivo; o custo é que dois eventos legitimamente idênticos viram um só.

Se só `fields` for declarado (sem `header`), a chave é composta como no poll: todos obrigatórios.

## O que o endpoint responde

Você não configura isso, mas precisa saber para explicar ao parceiro:

| Situação | Resposta |
| --- | --- |
| Item novo | `202` com o `eventId` |
| Reenvio de item já visto | `200` com o **mesmo** `eventId` do original |
| Lote misto | `202`, com o resultado item a item (`accepted` / `duplicate` / `filtered` / `rejected`) |
| Lote inteiro já visto | `200` |
| Sem credencial, ou errada | `401` |
| Corpo maior que `maxBodyBytes` | `413` |
| Corpo que não é JSON válido | `400` com o motivo |
| Método não declarado | `405` |
| Rota desconhecida | `404` |
| Acima do `rateLimit` | `429` |

Reenvio é comportamento de cliente bem-comportado, não erro — por isso `200` com o id original, e
não `409`.

## Modelo completo

```yaml
id: parceiro-y-eventos
name: Parceiro Y -> destino interno
client: parceiro-y
enabled: true

source:
  kind: http-endpoint
  path: /in/parceiro-y-eventos
  auth:
    kind: static-token
    header: X-Api-Key
    value: { secret: PARCEIRO_Y_API_KEY }
  itemsPath: eventos
  maxBodyBytes: 1048576
  rateLimit:
    perMinute: 600

dedupe:
  header: Idempotency-Key
  fields: [id_externo]
  onMissing: reject

transform:
  evento_id: { from: id_externo }
  ocorrido_em: { from: timestamp }

destinations:
  - id: interno
    method: POST
    url: https://destino.interno/eventos
    auth:
      kind: bearer
      token: { secret: DESTINO_INTERNO_TOKEN }
    retry:
      attempts: 5
      backoff: exponential
      initialDelayMs: 15000
```

## Ao entregar o fluxo, informe ao parceiro

O YAML sozinho não basta para o outro lado começar a mandar. Inclua no relato:

- a **URL completa** da rota (`https://<host-do-deployment>/in/<path>`)
- o **nome do header** de autenticação, e que o valor será combinado à parte — nunca por escrito no
  repositório
- o **formato do corpo**: com ou sem `itemsPath`, isto é, se mandam `{"eventos":[...]}` ou o objeto
  direto
- que reenviar é seguro e devolve `200` com o mesmo id — e que mandar `Idempotency-Key` torna a
  deduplicação confiável mesmo se o payload variar
