# The production image: the API as `npm start` runs it (tsx, no build step — the same code the
# stand runs). Migrations are applied on every start; they are idempotent (schema_migrations).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
USER node
EXPOSE 8787
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && exec node --import tsx src/server.ts"]
