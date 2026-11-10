FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM debian:bookworm-slim AS tailscale
ARG TAILSCALE_VERSION=1.104.5
ARG TARGETARCH=amd64
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz" | tar -xz -C /tmp \
 && mv /tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscale /tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscaled /usr/local/bin/

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/entrypoint.sh /entrypoint.sh
ENV NODE_ENV=production \
    REX_MCP_HOST=0.0.0.0 \
    REX_MCP_PORT=8787 \
    REX_MCP_STATE_DIR=/data \
    REX_MCP_DISCOVER=1 \
    REX_MCP_SOCKS_PROXY=socks5h://127.0.0.1:1055 \
    REX_MCP_TRUST_PROXY=uniquelocal \
    TS_HOSTNAME=rex-mcp
VOLUME ["/var/lib/tailscale", "/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
