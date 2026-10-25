# Serviço Oria (painel + serviço público). Instância única com volume em /data.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26-slim
ENV NODE_ENV=production ORIA_MODE=hosted DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY scripts/backup.mjs scripts/restore.mjs ./scripts/
USER node
EXPOSE 8080
CMD ["node", "src/platform/main.ts"]
