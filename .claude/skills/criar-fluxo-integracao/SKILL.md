---
name: criar-fluxo-integracao
description: Cria ou altera um fluxo de integração (pipeline) do app-api-gateway escrevendo apenas o YAML em `pipelines/` e os nomes dos segredos no `.env.example`, sem tocar em código. Use sempre que pedirem um fluxo novo, um pipeline novo, uma integração nova, ligar um cliente/terminal novo, consultar uma API de agendamento e repassar para outro sistema, expor uma rota para um parceiro empurrar evento, ou quando aparecerem termos como PIPELINES_DIR, itemsPath, dedupe, transform, http-poll, http-endpoint, GTS ou TSM — mesmo que a pessoa não use a palavra "pipeline" e mesmo que só mande um curl ou um trecho de código legado pedindo "faz isso funcionar aqui".
---

# Criar um fluxo de integração

Neste projeto um fluxo é **dado**, não código: um arquivo YAML em `pipelines/`, lido no boot a
partir de `PIPELINES_DIR`. Acrescentar um cliente novo não deve exigir uma linha de TypeScript — e se
parecer que exige, o certo é dizer isso em vez de contornar mexendo em `src/`.

Você vai mexer em, no máximo, dois lugares:

- `pipelines/<id>.yaml` — o fluxo
- `.env.example` — os **nomes** dos segredos novos, sempre sem valor

Nada mais. Se a tarefa realmente precisar de código (um `cast` que não existe, um tipo de
autenticação novo), pare e explique o que falta no motor, em vez de gerar um YAML que não vai
funcionar.

## Passo 1 — O usuário informa o tipo de entrada

Só existem dois, e é a única coisa que muda entre fluxos. Filtro, split, deduplicação, transformação
e entrega são idênticos nos dois.

| | `http-poll` | `http-endpoint` |
| --- | --- | --- |
| Quem inicia | o gateway, por cron | o parceiro, por POST |
| Pergunta que decide | "vamos **buscar** os dados?" | "o parceiro vai **mandar** os dados?" |
| Precisa de | URL da origem + credencial de saída | uma rota + credencial de entrada |

**Quem escolhe é o usuário, não você.** Se ele não disse explicitamente qual dos dois é, pergunte
antes de escrever qualquer coisa.

O motivo de não inferir: escolher errado não gera erro nenhum. Um `http-endpoint` criado quando se
queria `http-poll` sobe normalmente, registra a rota e simplesmente nunca coleta nada — e isso leva
semanas até alguém notar que os eventos pararam de chegar. Não existe sinal de erro para te corrigir
depois, então o custo de uma pergunta é sempre menor que o de um palpite.

Quando o pedido trouxer indícios fortes, use-os para **propor**, não para concluir. Um `curl` de
consulta, uma API paginada ou "a cada 5 minutos" sugerem poll; "o parceiro vai enviar", "webhook" ou
"eles fazem POST" sugerem endpoint. Nesses casos confirme em uma linha, algo como *"entendi que o
gateway vai consultar a API deles a cada 5 minutos (http-poll) — confere?"*, e siga só depois da
resposta. Indício forte continua sendo indício: já apareceu caso de um `curl` de exemplo que era só
como o parceiro testava a própria API, e não o que o gateway iria fazer.

Depois de decidir, leia o arquivo de referência correspondente, que traz o bloco `source` completo e
um modelo pronto:

- `references/http-poll.md`
- `references/http-endpoint.md`

## Passo 2 — Reúna os fatos que você não pode inventar

Estes vêm do usuário, de um `curl` homologado, ou do mapping legado. **Nenhum deles é adivinhável**,
e errar qualquer um produz falha silenciosa, não erro:

- **URL exata** da origem (poll) ou o caminho da rota (endpoint) — inclusive barra final, que faz parte da URL
- **Como autentica**, na origem e no destino: qual header, e se o valor é token fixo ou obtido num login
- **`itemsPath`**: o campo do corpo que contém o array de itens. Errar isso faz o fluxo coletar zero
  eventos para sempre, sem reclamar
- **Lista de status** (ou qualquer filtro): um status a menos descarta eventos legítimos em silêncio
- **Campos de origem e de destino** do `transform`
- **Campos da chave de deduplicação**

Se algum estiver faltando, pergunte. Um palpite aqui não vira um bug barulhento — vira evento que
nunca chega.

Bom atalho: **copie o pipeline existente mais parecido** e altere. Os arquivos em `pipelines/` são a
verdade sobre o que já funciona, e partir de um deles evita reinventar defaults.

## Passo 3 — Escreva o YAML

Nome do arquivo = `id` + `.yaml`. O `id` é kebab-case minúsculo, único entre todos os arquivos, e
costuma seguir `<cliente>-<local>-<produto>-<destino>`.

```yaml
id: cliente-local-produto-destino
name: Descrição legível do fluxo
client: cliente
enabled: true

source:
  # o bloco do tipo escolhido — ver references/
  ...

filter:     # opcional
dedupe:     # obrigatório
transform:  # obrigatório
destinations:  # obrigatório, pelo menos um
```

### `filter` — o que passa

Duas formas; `campo: [v1, v2]` é atalho para `{ in: [v1, v2] }`.

```yaml
filter:
  status: [NP, TP]                                # pertence à lista
  numero_pedido: { numeric: true, notEquals: 0 }  # predicados combinados com E
```

Predicados: `in`, `notIn`, `equals`, `notEquals`, `numeric`, `exists`.

Duas regras que costumam surpreender: **campo ausente reprova qualquer predicado** exceto
`exists: false` — o filtro existe para restringir, e um item sem o campo não satisfaz a restrição. E
**número e string numérica são o mesmo valor** (`41655302` casa com `"41655302"`), porque parceiros
alternam entre os dois para o mesmo id; booleano e `null` continuam estritos.

### `dedupe` — o que é "o mesmo evento"

É o que impede reentrega quando o poll repete a mesma página ou o parceiro reenvia o mesmo POST.
A forma muda conforme a entrada, e o arquivo de referência traz a sua.

```yaml
dedupe:
  fields: [numero_pedido, status]  # chave COMPOSTA: todos obrigatórios
  ttlDays: 90                      # opcional
```

Escolha os campos pensando em **o que muda quando há novidade**. No padrão GTS→TSM a chave é
`numero_pedido + status` justamente porque o mesmo pedido deve ser reenviado quando o status muda —
só `numero_pedido` entregaria a primeira mudança e engoliria todas as seguintes.

### `transform` — o payload de saída

Chave = caminho de **destino**, em notação de ponto (aninha sem sintaxe extra).

```yaml
transform:
  agendamento_id: { from: numero_pedido, cast: number }
  data: { from: data_status }
  evento.id: { from: status }
  origem: { const: GATEWAY }              # valor fixo
  canal: { from: canal, default: WEB }    # fallback quando falta
```

`cast`: `string`, `number`, `integer`, `boolean`, `iso-date`, `epoch-millis`, `trim`, `upper`,
`lower`. Um cast impossível **rejeita o item** em vez de mandar `NaN` ao destino.

Campo ausente e sem `default` é **omitido** do payload, não vira `null` — enviar `null` é afirmar um
valor, e nem todo destino trata os dois casos igual.

### `destinations` — para onde vai

```yaml
destinations:
  - id: destino
    method: POST
    url: https://destino.exemplo.com/eventos
    auth: { kind: bearer, token: { secret: DESTINO_TOKEN } }
    retry: { attempts: 5, backoff: exponential, initialDelayMs: 15000 }
```

Cada destino entrega de forma independente: um fora do ar não afeta o outro. Se um destino só deve
receber parte dos eventos, dê a ele um `filter` próprio (mesma sintaxe do filtro de cima) — assim o
evento que não casa nem gera linha de entrega.

Tipos de `auth` de saída: `none`, `bearer`, `basic`, `api-key`, `login-token`.

## Passo 4 — Segredos

Toda credencial é `{ secret: NOME }`, com `NOME` em `SCREAMING_SNAKE_CASE`. O schema **recusa** valor
literal em campo de credencial, e essa recusa é o ponto: um token em texto puro num YAML vai parar no
histórico do git e não sai mais de lá.

**Nunca compartilhe um segredo entre clientes ou entre fluxos.** Cada fluxo tem o seu, na origem e no
destino. Quando o contrato de um cliente termina e o token é revogado, isso não pode derrubar o fluxo
de outro. Se dois fluxos apontam para o mesmo destino, ainda assim cada um tem seu token.

Acrescente os nomes novos ao `.env.example`, **sempre sem valor**, agrupados perto dos segredos do
mesmo cliente. Se você não fizer isso, quem for provisionar não tem como saber o que falta, e o boot
vai recusar subir com "segredo não encontrado" — que é a mensagem certa, mas tarde demais.

Você não conhece o valor dos tokens, e não deve pedi-los: peça que a pessoa os defina no ambiente.

## Passo 5 — Valide

```bash
npx tsx .claude/skills/criar-fluxo-integracao/scripts/validar-pipelines.ts
```

Isso compila os YAML pelo mesmo caminho do boot e imprime o que o motor entendeu de cada um —
filtro, dedupe, transform, destinos — mais os avisos e a lista de segredos que faltam no ambiente.
Sai com código 1 se algum YAML for inválido, com o arquivo e o campo na mensagem.

Confira na saída, para o fluxo novo:

- `itemsPath` é o que você esperava, e não `(corpo inteiro e um item)` por engano
- o filtro tem as regras que você pretendia, e não uma a menos
- o transform lista todos os campos do payload de destino
- não apareceu nenhum **aviso** de dois fluxos com a mesma origem e o mesmo destino — isso entregaria
  cada evento duas vezes

Depois rode `npm test` para garantir que nada mais quebrou. Não é preciso subir Postgres nem Redis.

## Passo 6 — Relate

Diga, de forma curta:

1. **Qual arquivo foi criado** e o que ele faz
2. **Quais variáveis de ambiente provisionar** — os nomes, explicando que os valores não estão no repo
3. **Que suposições você fez** e como confirmá-las. Ex.: "modelei o header como token fixo a partir
   do curl; se for um JWT com validade, é trocar o bloco `auth`, sem tocar em código"
4. **O que ficou de fora**, se algo ficou

## Armadilhas que já custaram caro aqui

- **Copiar a janela de datas de outro fluxo.** `{today}` e `{today-2d}..{today+2d}` são janelas
  diferentes, e a errada faz o fluxo consultar um período que ninguém pediu. Confirme qual é.
- **Reaproveitar um `id` ou uma rota que já existe.** Dois pipelines com o mesmo `path` derrubam o
  boot — o que é bom —, mas duas origens iguais com o mesmo destino apenas **avisam**, e entregam
  tudo em duplicidade. O validador mostra esse aviso; leia-o.
- **Achar que `enabled: false` é comentário.** Um fluxo desabilitado fica inerte de verdade: não
  registra rota, não coleta e não tem os segredos exigidos no boot. É a forma correta de parar um
  fluxo cujo token foi revogado.
- **Inventar o `itemsPath` a partir do nome do endpoint.** Eles costumam coincidir e às vezes não.
  Confirme com um corpo de resposta real.
- **Mexer em `src/`.** Se o fluxo parece exigir isso, é informação valiosa: relate qual capacidade
  falta no motor, não contorne.
