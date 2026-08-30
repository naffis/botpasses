FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
USER node
EXPOSE 8788
ENV NODE_ENV=production
ENV VAULT_MODE=hosted
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/hosted/main.ts"]
