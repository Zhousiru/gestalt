# syntax=docker/dockerfile:1.7

ARG FORTRESS_VERSION=149.0.7827.232

FROM debian:bookworm-slim AS fortress

ARG FORTRESS_VERSION
ARG TARGETARCH

RUN test "$TARGETARCH" = "amd64" \
  || (echo "Fortress ${FORTRESS_VERSION} is packaged only for linux/amd64." >&2; exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    gzip \
    tar \
  && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:6553b8faf2a1274173f633f924d8131b5de20371cf2aa08a016da4b50a088a51 \
  https://github.com/tiliondev/fortress/releases/download/v${FORTRESS_VERSION}/tilion-fortress-linux-x64.tar.gz \
  /tmp/fortress.tar.gz

# The v149 release bundle misspells its launcher as "tillion".
RUN mkdir -p /opt/fortress \
  && tar --extract --gzip --file /tmp/fortress.tar.gz \
    --directory /opt/fortress --strip-components=1 \
  && if [ ! -e /opt/fortress/tilion ] && [ -x /opt/fortress/tillion ]; then \
    ln -s tillion /opt/fortress/tilion; \
  fi \
  && test -x /opt/fortress/tilion \
  && rm /tmp/fortress.tar.gz

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

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libvulkan1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    mesa-vulkan-drivers \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=fortress --chown=node:node /opt/fortress /opt/fortress
COPY --from=build --chown=node:node /opt/gestalt ./
COPY third_party/fortress/LICENSE third_party/fortress/NOTICE /usr/share/doc/fortress/

RUN mkdir -p "$GESTALT_HOME" /tmp/gestalt-fortress \
  && chown node:node "$GESTALT_HOME" /tmp/gestalt-fortress \
  && test -x /opt/fortress/tilion

USER node

VOLUME ["/var/lib/gestalt"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/main.js"]
