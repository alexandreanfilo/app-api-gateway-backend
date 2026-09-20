# Roadmap

Ordem de prioridade acordada. Cada item traz o que já existe no código, o que falta construir e
como saber que terminou — critério de aceite, não intenção.

---

## Já feito

- [x] **Repositório inicializado**, com `.gitignore` cobrindo `node_modules/`, `dist/`, `.env*`
      (exceto `.env.example`), material de TLS em `certs/` e arquivos de ferramenta local.
- [x] **Commit inicial** com a plataforma completa: núcleo de domínio isolado de framework,
      adaptadores HTTP/Postgres/BullMQ, carga e compilação de pipeline com Zod, observabilidade
      OpenTelemetry e as suítes unit/e2e/int/config.
- [x] **Um commit por fluxo YAML**, separados do commit inicial: ADM Porto Franco (grão),
      FTO Barcarena, FTO São Luís, Parceiro X e o exemplo desligado GTS São Luís.
- [x] **Carregamento do `.env` corrigido.** Nada no projeto lia o arquivo — não havia `dotenv`, nenhum
      script passava `--env-file` e o Node recusa essa flag em `NODE_OPTIONS`. Hoje `start` e
      `start:dev` usam o `--env-file` do Nest CLI, e `start:prod`/`migrate*` usam
      `--env-file-if-exists`, que não quebra onde o arquivo legitimamente não existe.
- [x] **`docker-compose.yml` alinhado.** O bloco `environment:` do serviço `gateway` listava segredos
      que já não existiam (`GTS_*`, `TSM_BEARER`) e `docker compose up --build` falhava no boot.
      Passou a usar `env_file` opcional apontando para o mesmo `.env`.
- [x] **Parceiro X desligado** (`enabled: false`): não há parceiro nem destino interno provisionados,
      e o carregador ignora segredo de pipeline inerte. Com isso, só os seis segredos dos três fluxos
      ativos são exigidos no boot.
- [x] **Driver de execução assistida** (`scripts/executar-fluxo.ts`, via `npm run fluxo`): executa um
      fluxo passo a passo — `consultar`, `preparar`, `enviar`, `plano` — reusando as mesmas funções do
      motor, com confirmação explícita antes de cada POST no destino real.
- [x] **Primeira entrega real validada.** ADM Porto Franco: 20 itens recebidos, 18 descartados pelo
      filtro, 2 prontos; o item 0 foi aceito pelo TSM (`HTTP 200`, evento `83875415`).
- [x] **Janela de consulta** `{today-2d}` adotada nos três fluxos ativos.

Pendências pequenas que sobraram desta etapa estão no fim do arquivo.

---

## 1. Gestão de segredos: sair do `.env` para um secret manager

**Por que.** Hoje todo segredo mora em um único `.env` na raiz, em texto puro, versionado só pela
disciplina de quem edita. Não há rotação, não há auditoria de quem leu o quê, não há escopo por
ambiente, e o arquivo já mostrou o custo disso na prática: token expirado convivendo com placeholder
de 18 caracteres sem ninguém perceber até a origem responder 401. Em produção as variáveis vêm do
orquestrador, o que resolve o armazenamento, mas não a rotação nem a auditoria.

**O que já existe a favor.** A porta `SecretResolver` (`src/core/ports/secret-resolver.ts`) foi
desenhada para isso: o YAML carrega apenas o **nome lógico** do segredo (`{ secret: NOME }`), nunca
um caminho de provedor. Trocar de backend é uma classe nova, sem tocar em YAML nenhum. A porta já
prevê `invalidate(name)`, e o `EnvSecretResolver` já faz cache com TTL de 60s e registra cada valor
lido no `secretRegistry`, que os remove de log e auditoria.

**O que construir.**

1. `AwsSecretsManagerResolver` (ou o provedor que a infra padronizar) implementando `SecretResolver`,
   com cache e TTL próprios e um mapa `nome lógico -> identificador no provedor` que viva em
   configuração de deployment, **não** no YAML de pipeline.
2. Seleção do resolvedor por ambiente no `bootstrapConfig`, com `EnvSecretResolver` seguindo como o
   caminho de desenvolvimento.
3. **Rotação que funcione sem deploy**: ao receber 401/403 do parceiro, invalidar o segredo em cache
   e tentar de novo uma vez antes de classificar a entrega como falha. Hoje um token trocado do lado
   do parceiro só é relido quando o TTL vence.
4. Diagnóstico na carga: o boot já recusa subir quando falta segredo; falta dizer **por que** o valor
   não serve quando ele existe mas está vencido. Um aviso de JWT expirado no `npm run fluxo --
   consultar` e no boot teria economizado a sessão de depuração desta semana.
5. Limpar o rastro: `.env.example` passa a documentar apenas os nomes lógicos, e o `env_file` do
   compose deixa de ser o caminho recomendado fora de desenvolvimento.

**Aceite.** Subir o gateway em um ambiente sem nenhum segredo em variável de ambiente; rotacionar um
token no provedor e ver a entrega seguinte passar sem restart; nenhum YAML alterado por causa da
troca; nenhum valor de segredo em log, traço ou corpo persistido.

---

## 2. Confirmar a independência entre coleta e entrega

**Por que.** A pergunta concreta: enquanto a coleta busca a página 2, a entrega da página 1 já deve
estar correndo. Se isso não acontece, um fluxo de 50 páginas serializa tudo e o tempo de ciclo vira a
soma das duas etapas em vez do máximo entre elas — com o agravante de que o cron dispara de 5 em 5
minutos e uma coleta lenta atropela a seguinte.

**O que o código diz hoje.** O desenho já é o pretendido, e vale registrar onde:

| Etapa | Onde | Comportamento |
| --- | --- | --- |
| Coleta | `HttpPollSource.collect` | gerador assíncrono que **rende um lote por página** |
| Persistência + fan-out | `PipelineRunner.processBatch` | roda por lote, em transação própria |
| Enfileiramento | `PipelineRunner.enqueue` | ao fim de **cada** lote, antes de a próxima página ser pedida |
| Entrega | `DeliveryProcessor` | worker BullMQ com `DELIVERY_CONCURRENCY` (8) jobs simultâneos |

Ou seja: as entregas da página 1 entram na fila antes de a requisição da página 2 sair. O que **não**
existe é prova disso, e há um detalhe que pode anular o ganho na prática — worker e coleta vivem no
**mesmo processo Node**, dividindo o mesmo event loop.

**O que construir.**

1. Teste de integração que force o entrelaçamento: origem com 3 páginas e destino que registra o
   instante de cada POST, afirmando que a primeira entrega acontece **antes** da última página ser
   buscada. Hoje nenhum teste cobre isso.
2. Instrumentação que torne o dado visível em produção: atributo de span com a página de origem da
   entrega e uma métrica de latência entre `pipeline_event.created_at` e a primeira tentativa de
   entrega.
3. Decidir sobre o **worker separado**: um modo de execução só-worker (sem HTTP, sem cron) para que
   entrega e coleta escalem independentemente. Isso muda o `docker-compose.yml` e o deployment, então
   é decisão de arquitetura, não ajuste de configuração.
4. Verificar o mesmo para o `DeliveryDrainer`, que hoje roda de 30 em 30 segundos no mesmo processo e
   disputa o mesmo event loop.

**Aceite.** Teste de integração verde provando a sobreposição; um traço real no OTLP mostrando entrega
da página 1 e coleta da página 2 em paralelo; decisão registrada sobre worker separado.

---

## 3. Front-end de acompanhamento, no estilo DAGs do Apache Airflow

**Por que.** Hoje a operação é `psql` e as consultas de plantão do README. Quem não escreve SQL não
enxerga o sistema, e a pergunta mais comum — "o evento do pedido X chegou no TSM?" — exige conhecer
três tabelas. Uma visão de grafo por pipeline, com o estado de cada etapa, resolve isso sem treinar
ninguém em SQL.

**O que já existe a favor.** Os dados estão todos no Postgres e são as três tabelas que a operação já
usa: `pipeline_run` (uma linha por página coletada, com contagens e status HTTP), `pipeline_event` (o
evento deduplicado, com payload) e `pipeline_delivery` (uma linha por evento × destino, com máquina
de estados, tentativas e corpo da resposta). O `/healthz` já expõe os pipelines carregados.

**O que construir.**

1. **API de leitura** — hoje inexistente. O gateway só tem `/healthz`, `/readyz` e `/in/*`. Precisa de
   endpoints de consulta paginada por pipeline, por período e por chave de deduplicação, com
   autenticação própria (o `InboundAuthSpec` de hoje é por pipeline, não serve para um painel).
2. **Modelo de DAG a partir do YAML.** O grafo já está descrito na configuração: origem → split →
   filtro → dedupe → transform → N destinos. Renderizar isso é derivar do pipeline compilado, não
   inventar um modelo novo.
3. **Duas visões, como no Airflow**: a do grafo (estrutura do pipeline, com contagens do último ciclo)
   e a de execuções (linha do tempo de `pipeline_run`, com drill-down até a entrega e a resposta do
   destino).
4. **Ações de operação**, no momento em que houver: reprocessar uma entrega, pausar um pipeline. Cada
   uma delas precisa passar pelo mesmo caminho do motor — nada de UPDATE direto na tabela.
5. Cuidado obrigatório: o painel mostra payload de parceiro. Redação e controle de acesso valem aqui
   tanto quanto no log, e a `mask.ts`/`secretRegistry` já existem para isso.

**Aceite.** Responder "o pedido X chegou no TSM?" em menos de um minuto, sem SQL, incluindo ver o
corpo enviado e a resposta do destino.

> O README declara UI de acompanhamento como fora de escopo **daquela versão**. Este item a traz de
> volta deliberadamente; quando entrar, a seção "Fora de escopo" precisa ser atualizada.

---

## Pendências herdadas

Pequenas, mas custam depuração se ficarem esquecidas:

- **`FTO_BARCARENA_TOKEN`** ainda é um valor opaco de 18 caracteres, não um JWT. O fluxo do Barcarena
  responde 401 e é o único dos três ativos que nunca foi exercitado ponta a ponta. A origem é outro
  host (`agendamento.lyin-s.com`), então provavelmente é outra credencial.
- **`FTO_BARCARENA_TSM_TOKEN` e `FTO_SAO_LUIS_TSM_TOKEN` têm o mesmo valor.** Pode ser proposital —
  mesmo cliente, mesmo tenant no TSM — mas o teste que trava "cada fluxo usa segredos exclusivos"
  compara os **nomes** das variáveis, não os valores, e não perceberia se não fosse.
- **A janela `{today-2d}` recua dois dias além do que o legado fazia.** O `pipelines-producao.config-spec.ts`
  foi atualizado para travar o offset novo, mas vale confirmar com a operação que dois dias cobrem o
  atraso real de agendamento corrigido retroativamente — o número saiu de estimativa, não de medição.
