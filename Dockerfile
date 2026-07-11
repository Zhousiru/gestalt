# syntax=docker/dockerfile:1.7

FROM node:24.11.1-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true

WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm config set store-dir /pnpm/store \
  && pnpm fetch

COPY . .

RUN pnpm install --offline --frozen-lockfile --filter @gestalt/app...

RUN pnpm run build \
  && pnpm --filter @gestalt/app deploy --prod /opt/gestalt

FROM node:24.11.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV GESTALT_HOME=/var/lib/gestalt

WORKDIR /opt/gestalt

COPY --from=build --chown=node:node /opt/gestalt ./

RUN mkdir -p "$GESTALT_HOME" \
  && chown node:node "$GESTALT_HOME"

USER node

VOLUME ["/var/lib/gestalt"]
EXPOSE 3000

ENTRYPOINT ["node", "dist/main.js"]
