# friends-relay — a containerized, infra-agnostic A2A relay. NOTHING about cloud,
# region, or a managed service is baked in: the relay reads its bind address, public
# URL, DID, invite policy, quotas/limits/TTL, and credentials ENTIRELY from injected
# env (see src/config.ts). TLS is expected to terminate at an injected reverse proxy
# (A2A requires HTTPS) — the image does not provision it.
#
# Build:  docker build -t friends-relay .
# Run:    docker run -p 8080:8080 \
#           -e RELAY_PUBLIC_URL=https://relay.example \
#           -e RELAY_DID=did:web:relay.example \
#           -e RELAY_ADMIN_CREDENTIAL=... \
#           friends-relay

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the unprivileged built-in `node` user.
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# The bind port is injected (RELAY_BIND_PORT); 8080 is the documented default.
EXPOSE 8080
CMD ["node", "dist/bin.js"]
