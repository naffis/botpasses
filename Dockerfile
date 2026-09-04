# Node 22 LTS. Keep the minor pinned to the one CI and local dev run (node --version).
# Dependabot (docker ecosystem) proposes the bump; do not float to node:22.
FROM node:22.22-bookworm-slim AS site
WORKDIR /site
COPY site/package.json site/package-lock.json ./
RUN npm ci
COPY site/ ./
RUN npm run build

FROM node:22.22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
# migrations/ + scripts/migrate.ts run as the Fly release_command before the new image serves.
COPY migrations ./migrations
COPY scripts ./scripts
COPY --from=site /site/dist ./site/dist
USER node
EXPOSE 8788
ENV NODE_ENV=production
ENV VAULT_MODE=hosted
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/hosted/main.ts"]
