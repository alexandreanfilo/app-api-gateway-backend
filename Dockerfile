# syntax=docker/dockerfile:1

# ============================================================================
# UM artefato, N deployments. Nada de build por cliente: esta imagem nao contem
# nenhum YAML de pipeline, nenhum certificado e nenhum segredo. A configuracao
# entra por fora, em tempo de execucao:
#   - definicoes de pipeline -> volume montado em PIPELINES_DIR
#   - certificados (mTLS)    -> volume montado, caminho referenciado no YAML
#   - tokens, senhas, DATABASE_URL -> variaveis de ambiente
# ============================================================================

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
# Compila src/ e scripts/ juntos: dist/src/main.js e dist/scripts/migrate.js.
RUN npm run build

FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Ponto de montagem do volume de pipelines. Vazio na imagem de proposito: se um
# YAML de cliente entrasse aqui, deixaria de existir "um artefato".
RUN mkdir -p /etc/gateway/pipelines /etc/gateway/certs && chown -R app:app /etc/gateway
ENV PIPELINES_DIR=/etc/gateway/pipelines

USER app
EXPOSE 3000

# tini como PID 1: sem ele o Node nao recebe SIGTERM corretamente e o
# encerramento gracioso (drenar workers antes de fechar o pool) nao acontece.
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main"]
