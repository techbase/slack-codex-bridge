# Optional packaging: see docs/setup.md for verification limits and CLI policy.
FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/bridge /home/node/.codex /workspace/project \
    && chown node:node /var/lib/bridge /home/node/.codex /workspace/project \
    && chmod 700 /var/lib/bridge /home/node/.codex
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
ENV HOME=/home/node
ENV PATH=/app/node_modules/.bin:$PATH
ENV BRIDGE_CONFIG=/run/bridge/config.json
USER node
ENTRYPOINT ["node", "dist/src/main.js"]
